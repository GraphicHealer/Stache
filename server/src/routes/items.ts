import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, query, placeholders } from '../db';
import { env } from '../env';
import { areas, items, photos } from '../db/schema';
import { breadcrumb } from '../lib/breadcrumb';
import { recordEventTx, type EventType } from '../lib/events';
import { insertPhoto, photoUrl, savePhotoFile, thumbUrl, thumbsForItems } from '../lib/photos';
import { detectObjects, kickAi, maybeQueueItem } from '../lib/ai';
import { analyzeItemPhoto, hasEmbedding, mlHealthy, nearestToItem } from '../lib/ml';
import { detectCodes, lookupBarcode, type DetectedCode } from '../lib/barcodes';
import { parseBody } from '../lib/validate';
import { z } from 'zod';

const ItemPatchSchema = z.object({
  area_id: z.string().optional(),
  status: z.enum(['home', 'out', 'lent', 'unaccounted', 'gone']).optional(),
  lent_to: z.string().max(200).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  barcode: z.string().max(64).nullable().optional(),
  detected_codes: z.array(z.any()).nullable().optional(),
  is_private: z.boolean().optional(),
  remind_snoozed_until: z.string().nullable().optional(),
  warranty_until: z.string().nullable().optional(),
  restock_below: z.union([z.number(), z.string(), z.null()]).optional(),
}).passthrough();

const SplitSchema = z.object({
  picks: z.array(z.object({
    name: z.string().max(200).nullish(),
    label: z.string().max(200).optional(),
    box: z.array(z.number()).length(4).optional(),
  })).min(1),
}).passthrough();

/** Scan an item's photos for codes; merge new finds into detected_codes. */
async function detectAndStore(itemId: string, bufs: Buffer[]): Promise<void> {
  const found = new Map<string, DetectedCode>();
  for (const buf of bufs) {
    for (const c of await detectCodes(buf)) found.set(c.text, c);
  }
  if (!found.size) return;
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) return;
  const prev = (item.detectedCodes as DetectedCode[] | null) ?? [];
  const merged = [...prev, ...[...found.values()].filter((c) => !prev.some((p) => p.text === c.text))];
  await db.update(items).set({ detectedCodes: merged }).where(eq(items.id, itemId));
}

function itemJson(i: typeof items.$inferSelect) {
  return {
    id: i.id,
    area_id: i.areaId,
    name: i.name,
    description: i.description,
    quantity: i.quantity,
    barcode: i.barcode,
    status: i.status,
    lent_to: i.lentTo,
    out_since: i.outSince,
    not_here_count: i.notHereCount,
    hidden: !!i.hiddenAt,
    created_at: i.createdAt,
    detected_codes: i.detectedCodes,
    owner_id: i.ownerId,
    is_private: i.isPrivate,
    takeout_count: i.takeoutCount,
    last_used: i.lastUsedAt,
    remind_snoozed_until: i.remindSnoozedUntil,
    warranty_until: i.warrantyUntil,
    restock_below: i.restockBelow,
    ai_name: i.aiName,
    ai_description: i.aiDescription,
    ai_tags: i.aiTags,
    ai_status: i.aiStatus,
    duplicate_of: i.duplicateOf,
  };
}

/** Private items are visible to their owner only - everyone else gets a 404. */
const hiddenFrom = (i: typeof items.$inferSelect, req: { user: { id: string } | null }) =>
  i.isPrivate && i.ownerId !== req.user?.id;

export async function itemRoutes(app: FastifyInstance) {
  // File an item. Accepts multipart (photo files + fields) - the normal path -
  // or plain JSON with an area_id.
  app.post('/api/items', async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: Buffer[] = [];

    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') files.push(await part.toBuffer());
        else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      }
    } else {
      Object.assign(fields, (req.body ?? {}) as Record<string, string>);
    }

    const areaId = fields.area_id;
    if (!areaId) return reply.badRequest('area_id is required');
    const [area] = await db
      .select({ id: areas.id })
      .from(areas)
      .where(and(eq(areas.id, areaId), isNull(areas.archivedAt)));
    if (!area) return reply.badRequest('area not found');

    // Offline replays carry a client_id - if the first attempt actually
    // landed, return the existing item instead of filing a duplicate.
    const clientId = fields.client_id || null;
    if (clientId) {
      const [existing] = await db.select().from(items).where(eq(items.clientId, clientId));
      if (existing) return { item: itemJson(existing), event_id: null, deduped: true };
    }

    let item: typeof items.$inferSelect;
    let ev: { id: string };
    try {
      ({ item, ev } = db.transaction((tx) => {
        const [i] = tx
          .insert(items)
          .values({
            areaId,
            name: fields.name || null,
            description: fields.description || null,
            quantity: Math.max(1, parseInt(fields.quantity ?? '1', 10) || 1),
            barcode: fields.barcode || null,
            ownerId: req.user?.id ?? null,
            isPrivate: fields.is_private === 'true',
            clientId,
          })
          .returning()
          .all();
        const e = recordEventTx(tx, 'item.filed', 'item', i.id, { area_id: areaId }, req.user?.id);
        return { item: i, ev: e };
      }));
    } catch (err) {
      // Concurrent replay - the unique index rejected the second insert.
      if (clientId) {
        const [existing] = await db.select().from(items).where(eq(items.clientId, clientId));
        if (existing) return { item: itemJson(existing), event_id: null, deduped: true };
      }
      throw err;
    }

    for (const buf of files) {
      const saved = await savePhotoFile(buf);
      const p = await insertPhoto(saved, { itemId: item.id });
      analyzeItemPhoto(item.id, p.id, p.path).catch((e) =>
        console.error('[ml] analyze failed:', e.message),
      );
    }

    if (files.length) {
      detectAndStore(item.id, files).catch(() => {});
      await maybeQueueItem(item.id);
      kickAi();
    }
    return reply.code(201).send({ item: itemJson(item), event_id: ev.id });
  });

  app.get('/api/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const [crumb, itemPhotos] = await Promise.all([
      breadcrumb(item.areaId),
      db.select().from(photos).where(eq(photos.itemId, id)).orderBy(asc(photos.createdAt)),
    ]);
    return {
      item: itemJson(item),
      breadcrumb: crumb,
      photos: itemPhotos.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })),
    };
  });

  app.patch('/api/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ItemPatchSchema, req.body, reply);
    if (!body) return;
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    // Events are collected, then written in one transaction with the update -
    // a failed update can't leave an undoable event for nothing.
    const evs: { type: EventType; payload: Record<string, unknown> }[] = [];

    // Move to another area.
    if (body.area_id !== undefined && body.area_id !== item.areaId) {
      const [area] = await db
        .select({ id: areas.id })
        .from(areas)
        .where(and(eq(areas.id, body.area_id), isNull(areas.archivedAt)));
      if (!area) return reply.badRequest('destination area not found');
      evs.push({
        type: 'item.moved',
        payload: { from_area_id: item.areaId, to_area_id: body.area_id },
      });
      item.areaId = body.area_id;
    }

    // Take out / lend / unaccounted / gone / put back home.
    if (body.status !== undefined && body.status !== item.status) {
      if (!['home', 'out', 'lent', 'unaccounted', 'gone'].includes(body.status))
        return reply.badRequest('status must be home|out|lent|unaccounted|gone');
      evs.push({
        type: 'item.status',
        payload: {
          prev: {
            status: item.status,
            lent_to: item.lentTo,
            out_since: item.outSince,
            hidden_at: item.hiddenAt,
            takeout_count: item.takeoutCount,
            last_used: item.lastUsedAt,
          },
          next: { status: body.status, lent_to: body.lent_to ?? null },
        },
      });
      const goingOut = ['out', 'lent'].includes(body.status) && item.status === 'home';
      item.status = body.status;
      item.lentTo = body.status === 'lent' ? (body.lent_to ?? item.lentTo) : null;
      if (body.status === 'home') {
        item.outSince = null;
        item.hiddenAt = null;
      } else if (!item.outSince) {
        item.outSince = new Date();
      }
      if (goingOut) {
        item.lastUsedAt = new Date();
        item.takeoutCount += 1;
      }
      if (body.status === 'gone') item.hiddenAt = new Date();
    }

    if (
      body.remind_snoozed_until !== undefined &&
      body.remind_snoozed_until !== null &&
      isNaN(new Date(body.remind_snoozed_until).getTime())
    )
      return reply.badRequest('remind_snoozed_until must be a valid date');

    const editable = {
      name: 'name',
      description: 'description',
      quantity: 'quantity',
      barcode: 'barcode',
      detected_codes: 'detectedCodes',
      is_private: 'isPrivate',
      remind_snoozed_until: 'remindSnoozedUntil',
      warranty_until: 'warrantyUntil',
      restock_below: 'restockBelow',
    } as const;
    const prev: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(editable)) {
      const raw = body[key as keyof typeof body];
      if (raw !== undefined && raw !== (item as any)[col]) {
        prev[col] = (item as any)[col];
        next[col] = raw;
        (item as any)[col] =
          key === 'quantity'
            ? Math.max(1, parseInt(String(raw), 10) || 1)
            : key === 'remind_snoozed_until' && raw
              ? new Date(raw as string)
              : key === 'restock_below'
                ? (raw === null ? null : Math.max(0, parseInt(String(raw), 10) || 0))
                : raw;
      }
    }
    if (Object.keys(prev).length) {
      evs.push({ type: 'item.updated', payload: { prev, next } });
    }

    // A private item with no owner would be invisible to everyone.
    if (item.isPrivate && !item.ownerId) item.ownerId = req.user?.id ?? null;

    const { updated, eventIds } = db.transaction((tx) => {
      const ids = evs.map((e) => recordEventTx(tx, e.type, 'item', id, e.payload, req.user?.id).id);
      const [u] = tx
        .update(items)
        .set({
          areaId: item.areaId,
          status: item.status,
          lentTo: item.lentTo,
          outSince: item.outSince,
          name: item.name,
          description: item.description,
          quantity: item.quantity,
          barcode: item.barcode,
          detectedCodes: item.detectedCodes,
          isPrivate: item.isPrivate,
          hiddenAt: item.hiddenAt,
          takeoutCount: item.takeoutCount,
          ownerId: item.ownerId,
          lastUsedAt: item.lastUsedAt,
          remindSnoozedUntil: item.remindSnoozedUntil,
          warrantyUntil: item.warrantyUntil,
          restockBelow: item.restockBelow,
        })
        .where(eq(items.id, id))
        .returning()
        .all();
      return { updated: u, eventIds: ids };
    });
    return { item: itemJson(updated), event_ids: eventIds };
  });

  app.post('/api/items/:id/photos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const saved = [];
    const bufs: Buffer[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        bufs.push(buf);
        const p = await insertPhoto(await savePhotoFile(buf), { itemId: id });
        saved.push(p);
        analyzeItemPhoto(id, p.id, p.path).catch((e) => console.error('[ml] analyze failed:', e.message));
      }
    }
    if (!saved.length) return reply.badRequest('no photo uploaded');
    detectAndStore(id, bufs).catch(() => {});
    return reply
      .code(201)
      .send({ photos: saved.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })) });
  });

  // "Not here" - lowers confidence and suggests where else to look.
  app.post('/api/items/:id/not-here', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');

    const { ev, updated } = db.transaction((tx) => {
      const e = recordEventTx(tx, 'item.not_here', 'item', id, {
        count_before: item.notHereCount,
        area_id: item.areaId,
        status_before: item.status,
        out_since_before: item.outSince,
      }, req.user?.id);
      const [u] = tx
        .update(items)
        .set({
          notHereCount: item.notHereCount + 1,
          // "Not here" means the location is unknown - it's unaccounted for.
          status: item.status === 'home' ? 'unaccounted' : item.status,
          outSince: item.outSince ?? new Date(),
        })
        .where(eq(items.id, id))
        .returning()
        .all();
      return { ev: e, updated: u };
    });

    // Suggest: areas it lived in before (from move events) + siblings of current area.
    const prevAreas = query<{ area_id: string }>(
      `SELECT DISTINCT json_extract(payload, '$.from_area_id') AS area_id
       FROM events
       WHERE type = 'item.moved' AND entity_id = ? AND undone_at IS NULL`,
      id,
    );
    const siblings = query<{ area_id: string }>(
      `SELECT id AS area_id FROM areas
       WHERE archived_at IS NULL AND parent_id IS
         (SELECT parent_id FROM areas WHERE id = ?)
         AND id <> ?
       LIMIT 6`,
      item.areaId,
      item.areaId,
    );
    const ids = [...new Set([...prevAreas, ...siblings].map((r) => r.area_id).filter(Boolean))];
    const suggested = ids.length
      ? query<{ id: string; name: string | null }>(
          `SELECT id, name FROM areas WHERE id IN (${placeholders(ids.length)}) AND archived_at IS NULL`,
          ...ids,
        )
      : [];

    return { item: itemJson(updated), suggested_areas: suggested, event_id: ev.id };
  });

  // Visually similar items via CLIP embeddings.
  app.get('/api/items/:id/similar', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    if (!mlHealthy()) return { items: [], ml: false };
    const neighbors = await nearestToItem(id, 12, req.user?.id ?? null);
    const thumbs = await thumbsForItems(neighbors.map((n) => n.id));
    const meta = neighbors.length
      ? query<{ id: string; name: string | null; area_id: string; quantity: number; status: string }>(
          `SELECT id, name, area_id, quantity, status FROM items WHERE id IN (${placeholders(neighbors.length)})`,
          ...neighbors.map((n) => n.id),
        )
      : [];
    const byId = new Map(meta.map((m: any) => [m.id, m]));
    return {
      ml: true,
      items: neighbors.map((n) => {
        const m: any = byId.get(n.id);
        const t = thumbs.get(n.id);
        return {
          id: n.id,
          name: m?.name,
          area_id: m?.area_id,
          quantity: m?.quantity,
          status: m?.status,
          similarity: 1 - n.dist,
          thumb: t ? thumbUrl(t) : null,
          photo: t ? photoUrl(t) : null,
        };
      }),
    };
  });

  // Where similar things already live - CLIP neighbors' areas, weighted by
  // similarity. Suggestion only; the user moves it or doesn't.
  app.get('/api/items/:id/suggested-area', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    if (!mlHealthy() || !hasEmbedding(id)) return { suggestions: [] };

    const neighbors = await nearestToItem(id, 12, req.user?.id ?? null);
    if (!neighbors.length) return { suggestions: [] };
    const meta = query<{ id: string; area_id: string }>(
      `SELECT id, area_id FROM items WHERE id IN (${placeholders(neighbors.length)})`,
      ...neighbors.map((n) => n.id),
    );
    const areaOf = new Map(meta.map((m) => [m.id, m.area_id]));

    const score = new Map<string, number>();
    for (const n of neighbors) {
      const a = areaOf.get(n.id);
      if (a && a !== item.areaId) score.set(a, (score.get(a) ?? 0) + (1 - n.dist));
    }
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const suggestions = await Promise.all(
      top.map(async ([areaId, s]) => {
        const c = await breadcrumb(areaId);
        return {
          area_id: areaId,
          name: c.at(-1)?.name ?? null,
          path: c.map((x) => x.name ?? '?').join(' › '),
          score: Math.round(s * 100) / 100,
        };
      }),
    );
    return { suggestions };
  });

  // Pile splitting, step 1: ask the VLM what distinct objects are in the
  // photo. Suggestions only - nothing is created until the user confirms.
  app.post('/api/items/:id/split-suggestions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const [photo] = await db
      .select()
      .from(photos)
      .where(eq(photos.itemId, id))
      .orderBy(asc(photos.createdAt))
      .limit(1);
    if (!photo) return reply.badRequest('item has no photo to split');
    try {
      const suggestions = await detectObjects(
        path.join(env.dataDir, 'photos', photo.path),
        item.isPrivate,
      );
      return { suggestions, photo_url: photoUrl(photo) };
    } catch (e) {
      return reply.badRequest(`split detection failed: ${(e as Error).message}`);
    }
  });

  // Pile splitting, step 2: file the objects the user actually checked.
  // New items share the source item's home area; each gets a crop of the photo.
  app.post('/api/items/:id/split', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { picks } = parseBody(SplitSchema, req.body, reply) ?? {};
    if (!picks) return;
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const [photo] = await db
      .select()
      .from(photos)
      .where(eq(photos.itemId, id))
      .orderBy(asc(photos.createdAt))
      .limit(1);
    if (!photo) return reply.badRequest('item has no photo to split');

    const file = path.join(env.dataDir, 'photos', photo.path);
    const meta = await sharp(file).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const created = [];
    const eventIds: string[] = [];

    for (const pick of picks.slice(0, 12)) {
      const b = pick.box ?? [];
      if (b.length !== 4) continue;
      // box is [ymin, xmin, ymax, xmax] normalized 0-1000.
      const left = Math.max(0, Math.round((b[1] / 1000) * W));
      const top = Math.max(0, Math.round((b[0] / 1000) * H));
      const width = Math.min(W - left, Math.round(((b[3] - b[1]) / 1000) * W));
      const height = Math.min(H - top, Math.round(((b[2] - b[0]) / 1000) * H));
      if (width < 16 || height < 16) continue;

      const buf = await sharp(file).extract({ left, top, width, height }).toBuffer();
      const name = pick.name?.trim() || null;
      const { child, ev } = db.transaction((tx) => {
        const [c] = tx
          .insert(items)
          .values({
            areaId: item.areaId,
            name,
            aiName: name ? null : (pick.label ?? null),
            ownerId: item.ownerId,
            isPrivate: item.isPrivate,
          })
          .returning()
          .all();
        const e = recordEventTx(tx, 'item.filed', 'item', c.id, {
          area_id: item.areaId,
          via: 'split',
          source_item_id: id,
        }, req.user?.id);
        return { child: c, ev: e };
      });
      const saved = await savePhotoFile(buf);
      const cp = await insertPhoto(saved, { itemId: child.id });
      analyzeItemPhoto(child.id, cp.id, saved.path).catch(() => {});
      eventIds.push(ev.id);
      created.push({ id: child.id, name: child.name, thumb: `/photos/${saved.thumbPath}` });
    }
    for (const c of created) await maybeQueueItem(c.id);
    if (created.length) kickAi();
    return { items: created, event_ids: eventIds };
  });

  // Free external product lookup for a scanned/found barcode.
  app.get('/api/codes/:code/lookup', async (req, reply) => {
    const { code } = req.params as { code: string };
    const product = await lookupBarcode(code);
    return { code, product };
  });

  // Hide (soft delete) - undoable.
  app.delete('/api/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const ev = db.transaction((tx) => {
      tx.update(items).set({ hiddenAt: new Date() }).where(eq(items.id, id)).run();
      return recordEventTx(tx, 'item.hidden', 'item', id, { name: item.name }, req.user?.id);
    });
    return { ok: true, event_id: ev.id };
  });

  // Restore from trash - inverse of hide, and itself undoable.
  app.post('/api/items/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    const ev = db.transaction((tx) => {
      tx.update(items).set({ hiddenAt: null }).where(eq(items.id, id)).run();
      return recordEventTx(tx, 'item.restored', 'item', id, { name: item.name }, req.user?.id);
    });
    return { ok: true, event_id: ev.id };
  });

  // Permanent delete - removes the row, its photo rows, files, and vectors.
  // Only for the Trash page; hiding is the normal path.
  app.delete('/api/items/:id/purge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item || hiddenFrom(item, req)) return reply.notFound('item not found');
    if (!item.hiddenAt) return reply.badRequest('only hidden items can be purged');
    const pics = await db.select().from(photos).where(eq(photos.itemId, id));
    db.transaction((tx) => {
      tx.delete(photos).where(eq(photos.itemId, id)).run();
      tx.delete(items).where(eq(items.id, id)).run();
    });
    for (const p of pics) {
      for (const f of [p.path, p.thumbPath].filter(Boolean)) {
        fs.rm(path.join(env.dataDir, 'photos', f!), { force: true }).catch(() => {});
      }
    }
    query('DELETE FROM photo_embeddings WHERE item_id = ?', id);
    return { ok: true };
  });
}
