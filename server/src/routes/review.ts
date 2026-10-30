import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../db';
import { areas, items, photos } from '../db/schema';
import { photoDir, regenerateThumb, thumbsForItems, thumbUrl } from '../lib/photos';
import { itemVisible } from '../lib/visibility';
import { requireAdmin } from '../lib/guards';
import { recordEventTx } from '../lib/events';
import { LABEL_CODE_RE } from '../lib/labelcode';

const ImportSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().max(300).nullable().optional(),
      note: z.string().max(2000).nullable().optional(),
      quantity: z.union([z.number(), z.string()]).optional(),
      tags: z.array(z.string().max(50)).max(50).optional(),
      barcode: z.string().max(100).nullable().optional(),
      status: z.enum(['home', 'out', 'lent', 'unaccounted']).optional(),
      lent_to: z.string().max(200).nullable().optional(),
      // Area by explicit id, a label code, or a name (find-or-create at root).
      area_id: z.string().nullable().optional(),
      area_label: z.string().nullable().optional(),
      area_name: z.string().max(200).nullable().optional(),
      private: z.boolean().optional(),
    }),
  ).min(1).max(1000),
  dry_run: z.boolean().optional(),
});

export async function reviewRoutes(app: FastifyInstance) {
  // Review queue: AI-flagged duplicates, unnamed ("incomplete") items, and
  // items whose AI processing failed - one list, one pass.
  app.get('/api/review-queue', async (req) => {
    const visible = itemVisible(req.user?.id ?? null);

    const dupRows = await db
      .select()
      .from(items)
      .where(and(isNotNull(items.duplicateOf), isNull(items.hiddenAt), visible));
    const dupIds = new Set(dupRows.flatMap((d) => [d.id, d.duplicateOf!]));
    const originals = dupIds.size
      ? await db.select().from(items).where(
          and(
            isNull(items.hiddenAt),
            // originals are looked up loosely - may include the dup itself
            // when its original was hidden; filtered below
            isNotNull(items.id),
          ),
        )
      : [];
    const byId = new Map(originals.map((o) => [o.id, o]));
    const thumbs = await thumbsForItems([...dupIds]);

    const duplicates = [];
    for (const d of dupRows) {
      const orig = byId.get(d.duplicateOf!);
      if (!orig) continue; // original gone or hidden - nothing to compare
      const dt = thumbs.get(d.id);
      const ot = thumbs.get(orig.id);
      duplicates.push({
        id: d.id,
        name: d.name ?? d.aiName,
        thumb: dt ? thumbUrl(dt) : null,
        original: {
          id: orig.id,
          name: orig.name ?? orig.aiName,
          thumb: ot ? thumbUrl(ot) : null,
          area_id: orig.areaId,
        },
      });
    }

    const incomplete = await db
      .select({ id: items.id, aiName: items.aiName, createdAt: items.createdAt })
      .from(items)
      .where(and(isNull(items.name), isNull(items.hiddenAt), visible))
      .limit(50);
    const incThumbs = await thumbsForItems(incomplete.map((i) => i.id));

    const failed = await db
      .select({ id: items.id, name: items.name, aiName: items.aiName })
      .from(items)
      .where(and(eq(items.aiStatus, 'failed'), isNull(items.hiddenAt), visible))
      .limit(50);
    const failThumbs = await thumbsForItems(failed.map((i) => i.id));

    return {
      duplicates,
      incomplete: incomplete.map((i) => {
        const t = incThumbs.get(i.id);
        return { id: i.id, ai_name: i.aiName, thumb: t ? thumbUrl(t) : null };
      }),
      failed_ai: failed.map((i) => {
        const t = failThumbs.get(i.id);
        return { id: i.id, name: i.name ?? i.aiName, thumb: t ? thumbUrl(t) : null };
      }),
    };
  });

  // JSON import (CSV is converted client-side). Each row resolves its area
  // by id → label → name (find-or-create at root). dry_run previews without
  // writing. Everything created in one go is one undoable multi event.
  app.post('/api/import', async (req, reply) => {
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? 'invalid import');
    }
    const rows = parsed.data.items;
    const dryRun = parsed.data.dry_run;
    const uid = req.user?.id ?? null;

    // Resolve areas up front so the preview reports what would be created.
    const allAreas = await db.select().from(areas).where(isNull(areas.archivedAt));
    const byName = new Map(allAreas.map((a) => [a.name?.toLowerCase() ?? '', a]));
    const byId = new Map(allAreas.map((a) => [a.id, a]));
    const labelRows = query<{ code: string; area_id: string | null }>(
      `SELECT code, area_id FROM labels WHERE area_id IS NOT NULL`,
    );
    const byLabel = new Map(labelRows.map((l) => [l.code.toUpperCase(), l.area_id!]));

    type Plan = { idx: number; name: string | null; areaId: string | null; createArea: string | null; error?: string };
    const plan: Plan[] = [];
    const areaIds = new Set(byId.keys());

    for (const [idx, r] of rows.entries()) {
      let areaId: string | null = null;
      let createArea: string | null = null;
      if (r.area_id) {
        if (!areaIds.has(r.area_id)) {
          plan.push({ idx, name: r.name ?? null, areaId: null, createArea: null, error: 'unknown area_id' });
          continue;
        }
        areaId = r.area_id;
      } else if (r.area_label) {
        if (!LABEL_CODE_RE.test(r.area_label)) {
          plan.push({ idx, name: r.name ?? null, areaId: null, createArea: null, error: 'bad label code' });
          continue;
        }
        areaId = byLabel.get(r.area_label.toUpperCase()) ?? null;
        if (!areaId) {
          plan.push({ idx, name: r.name ?? null, areaId: null, createArea: null, error: 'label not attached to an area' });
          continue;
        }
      } else if (r.area_name) {
        const found = byName.get(r.area_name.toLowerCase());
        if (found) areaId = found.id;
        else createArea = r.area_name;
      }
      plan.push({ idx, name: r.name ?? null, areaId, createArea });
    }

    // Rows without any area spec land in a find-or-create "Unsorted" root
    // area - capture first, sort later.
    const needsUnsorted = plan.some((p) => !p.error && !p.areaId && !p.createArea);

    if (dryRun) {
      return {
        dry_run: true,
        total: rows.length,
        create: plan.filter((p) => !p.error).length,
        errors: plan.filter((p) => p.error).map((p) => ({ row: p.idx, error: p.error })),
        new_areas: [
          ...new Set(plan.map((p) => p.createArea).filter(Boolean)),
          ...(needsUnsorted && !byName.has('unsorted') ? ['Unsorted'] : []),
        ],
      };
    }

    const created: { id: string; name: string | null }[] = [];
    const errors = plan.filter((p) => p.error).map((p) => ({ row: p.idx, error: p.error }));
    const newAreaIds = new Map<string, string>(); // name -> id

    const ev = db.transaction((tx) => {
      const changes: { id: string }[] = [];
      const createdAreas: { id: string }[] = [];

      // Create any new root areas first.
      for (const name of new Set(plan.map((p) => p.createArea).filter(Boolean) as string[])) {
        const [a] = tx.insert(areas).values({ name }).returning().all();
        newAreaIds.set(name, a.id);
        createdAreas.push({ id: a.id });
        recordEventTx(tx, 'area.created', 'area', a.id, { name, via: 'import' }, uid);
      }

      // The catch-all for area-less rows.
      if (needsUnsorted) {
        const existing = byName.get('unsorted');
        const [u] = existing
          ? [existing]
          : tx.insert(areas).values({ name: 'Unsorted' }).returning().all();
        newAreaIds.set('\0unsorted', u.id);
        if (!existing) {
          createdAreas.push({ id: u.id });
          recordEventTx(tx, 'area.created', 'area', u.id, { name: 'Unsorted', via: 'import' }, uid);
        }
      }

      for (const p of plan) {
        if (p.error) continue;
        const r = rows[p.idx];
        const areaId =
          p.areaId ??
          (p.createArea ? newAreaIds.get(p.createArea)! : newAreaIds.get('\0unsorted')!);
        const qty = r.quantity === undefined || r.quantity === null ? 1 : Number(r.quantity);
        const [it] = tx
          .insert(items)
          .values({
            areaId,
            name: r.name ?? null,
            description: r.note ?? null,
            quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
            barcode: r.barcode ?? null,
            status: r.status ?? 'home',
            lentTo: r.status === 'lent' ? (r.lent_to ?? null) : null,
            outSince: r.status && r.status !== 'home' ? new Date() : null,
            tags: r.tags ?? null,
            isPrivate: r.private === true,
            ownerId: r.private === true ? uid : null,
          })
          .returning()
          .all();
        created.push({ id: it.id, name: it.name });
        changes.push({ id: it.id });
      }
      if (changes.length) {
        return recordEventTx(tx, 'item.filed', 'multi', 'import', {
          ids: changes.map((c) => c.id),
          area_ids: createdAreas.map((a) => a.id),
          via: 'import',
        }, uid);
      }
      return null;
    });

    return reply.code(201).send({
      created,
      errors,
      event_id: ev?.id,
    });
  });

  // --- Photo maintenance ----------------------------------------------------
  // Disk-vs-DB reconciliation: orphan files, dangling rows, missing thumbs.
  // Admin-only - it deletes files.

  const maintenanceReport = async () => {
    const dir = photoDir();
    let onDisk = new Set<string>();
    try {
      onDisk = new Set((await fs.readdir(dir)).filter((f) => f.endsWith('.webp')));
    } catch {
      /* empty dir */
    }
    const rows = await db.select().from(photos);
    const referenced = new Set<string>();
    const missingFiles: string[] = [];
    const missingThumbs: string[] = [];
    for (const p of rows) {
      referenced.add(p.path);
      if (p.thumbPath) referenced.add(p.thumbPath);
      if (!onDisk.has(p.path)) missingFiles.push(p.id);
      else if (p.thumbPath && !onDisk.has(p.thumbPath)) missingThumbs.push(p.id);
    }
    const orphanFiles = [...onDisk].filter((f) => !referenced.has(f));
    return { orphan_files: orphanFiles, missing_files: missingFiles, missing_thumbs: missingThumbs };
  };

  app.get('/api/photos/maintenance', { preHandler: requireAdmin }, async () => {
    const r = await maintenanceReport();
    return {
      orphan_files: r.orphan_files.length,
      dangling_rows: r.missing_files.length,
      missing_thumbs: r.missing_thumbs.length,
    };
  });

  const MaintainSchema = z.object({
    action: z.enum(['delete_orphans', 'repair_thumbs', 'prune_dangling']),
  });

  app.post('/api/photos/maintenance', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = MaintainSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest('bad action');
    const r = await maintenanceReport();
    const dir = photoDir();

    if (parsed.data.action === 'delete_orphans') {
      for (const f of r.orphan_files) {
        await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
      }
      return { ok: true, deleted: r.orphan_files.length };
    }
    if (parsed.data.action === 'repair_thumbs') {
      const all = await db.select().from(photos);
      const byId = new Map(all.map((p) => [p.id, p]));
      let fixed = 0;
      for (const id of r.missing_thumbs) {
        const p = byId.get(id);
        if (!p) continue;
        try {
          const thumbPath = await regenerateThumb(p);
          if (thumbPath !== p.thumbPath) {
            await db.update(photos).set({ thumbPath }).where(eq(photos.id, p.id));
          }
          fixed++;
        } catch {
          /* unreadable original - leave it */
        }
      }
      return { ok: true, repaired: fixed };
    }
    // prune_dangling: photo rows whose original file is gone.
    let pruned = 0;
    for (const id of r.missing_files) {
      await db.delete(photos).where(eq(photos.id, id));
      pruned++;
    }
    return { ok: true, pruned };
  });
}
