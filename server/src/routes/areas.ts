import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { areas, labels, photos } from '../db/schema';
import { breadcrumb, descendantAreaIds, subtreeItemCounts } from '../lib/breadcrumb';
import { recordEventTx } from '../lib/events';
import {
  assertImage,
  coverThumbsForAreas,
  PhotoBusyError,
  photoUrl,
  removePhotoFiles,
  savePhotoFile,
  thumbUrl,
  thumbsForItems,
} from '../lib/photos';
import type { SavedPhoto } from '../lib/photos';
import { items } from '../db/schema';
import { itemVisible } from '../lib/visibility';
import { parseBody } from '../lib/validate';
import { LABEL_CODE_RE } from '../lib/labelcode';
import { z } from 'zod';

const CreateAreaSchema = z.object({
  name: z.string().max(200).nullish(),
  parent_id: z.string().nullish(),
  label_code: z.string().regex(LABEL_CODE_RE, 'invalid label code').nullish(),
  category: z.string().max(100).nullish(),
}).passthrough();

const PatchAreaSchema = z.object({
  name: z.string().max(200).nullish(),
  parent_id: z.string().nullish(),
  cover_photo_id: z.string().nullish(),
  tags: z.array(z.string().max(50)).max(50).nullable().optional(),
  category: z.string().max(100).nullish(),
}).passthrough();

const StocktakeSchema = z.object({
  present_ids: z.array(z.string()).max(5000),
  // When false, unticked items are left alone instead of flagged unaccounted.
  mark_unaccounted: z.boolean().optional(),
}).passthrough();

function areaJson(
  a: typeof areas.$inferSelect,
  cover?: { thumbUrl: string; url: string } | null,
  itemCount?: number,
) {
  return {
    id: a.id,
    parent_id: a.parentId,
    name: a.name,
    label_code: a.labelCode,
    cover_photo_id: a.coverPhotoId,
    cover_thumb: cover?.thumbUrl ?? null,
    cover_url: cover?.url ?? null,
    created_at: a.createdAt,
    archived_at: a.archivedAt,
    last_audit_at: a.lastAuditAt,
    tags: a.tags ?? [],
    category: a.category,
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
  };
}

export async function areaRoutes(app: FastifyInstance) {
  // Root areas for browsing; ?all=1 returns every live area (parent pickers).
  app.get('/api/areas', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    const roots = await db
      .select()
      .from(areas)
      .where(all ? isNull(areas.archivedAt) : and(isNull(areas.parentId), isNull(areas.archivedAt)))
      .orderBy(asc(areas.createdAt));
    const covers = await coverThumbsForAreas(roots);
    const counts = await subtreeItemCounts(
      roots.map((a) => a.id),
      req.user?.id ?? null,
    );
    return {
      areas: roots.map((a) => {
        const c = covers.get(a.id);
        return areaJson(a, c ? { thumbUrl: thumbUrl(c), url: photoUrl(c) } : null, counts.get(a.id) ?? 0);
      }),
    };
  });

  // Create an area - optionally claiming a pre-printed label.
  app.post('/api/areas', async (req, reply) => {
    const body = parseBody(CreateAreaSchema, req.body, reply);
    if (!body) return;

    if (body.parent_id) {
      const [parent] = await db.select().from(areas).where(eq(areas.id, body.parent_id));
      if (!parent || parent.archivedAt) return reply.notFound('parent area not found');
    }

    let labelCode: string | null = null;
    if (body.label_code) {
      const [label] = await db.select().from(labels).where(eq(labels.code, body.label_code.toUpperCase()));
      if (!label) return reply.badRequest('unknown label code');
      if (label.areaId) return reply.conflict('label already claimed');
      labelCode = label.code;
    }

    let created: { area: typeof areas.$inferSelect; ev: { id: string } };
    try {
      created = db.transaction((tx) => {
        const [a] = tx
          .insert(areas)
          .values({ name: body.name ?? null, parentId: body.parent_id ?? null, labelCode, category: body.category ?? null })
          .returning()
          .all();
        if (labelCode) {
          // Atomic claim - a concurrent claim makes this a no-op.
          const r = tx
            .update(labels)
            .set({ areaId: a.id })
            .where(and(eq(labels.code, labelCode), isNull(labels.areaId)))
            .run();
          if (r.changes === 0) throw new Error('CONFLICT:label claimed');
        }
        const e = recordEventTx(tx, 'area.created', 'area', a.id, {
          label_code: labelCode,
          parent_id: a.parentId,
        }, req.user?.id);
        return { area: a, ev: e };
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('CONFLICT:') || msg.includes('UNIQUE'))
        return reply.conflict('label already claimed');
      throw e;
    }
    return reply.code(201).send({ area: areaJson(created.area), event_id: created.ev.id });
  });

  // Area detail: breadcrumb, sub-areas, contents. ?deep=1 returns items from
  // the whole subtree (each tagged with its own area path).
  app.get('/api/areas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deep = (req.query as { deep?: string }).deep === '1';
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');

    const scopeIds = deep ? await descendantAreaIds(id) : [id];
    const [crumb, subs, contents, areaPhotos] = await Promise.all([
      breadcrumb(id),
      db
        .select()
        .from(areas)
        .where(and(eq(areas.parentId, id), isNull(areas.archivedAt)))
        .orderBy(asc(areas.createdAt)),
      db
        .select()
        .from(items)
        .where(
          and(
            inArray(items.areaId, scopeIds),
            isNull(items.hiddenAt),
            itemVisible(req.user?.id ?? null),
          ),
        )
        .orderBy(asc(items.createdAt)),
      db.select().from(photos).where(eq(photos.areaId, id)),
    ]);

    const covers = await coverThumbsForAreas(subs);
    const subCounts = await subtreeItemCounts(subs.map((a) => a.id), req.user?.id ?? null);
    const thumbs = await thumbsForItems(contents.map((i) => i.id));
    const cover = areaPhotos.find((p) => p.id === area.coverPhotoId) ?? areaPhotos[0];
    const areaNames = new Map(subs.map((a) => [a.id, a.name]));
    const itemAreaName = async (areaId: string) => {
      if (areaId === id) return null;
      if (areaNames.has(areaId)) return areaNames.get(areaId) ?? null;
      const [a] = await db.select({ name: areas.name }).from(areas).where(eq(areas.id, areaId));
      return a?.name ?? null;
    };

    const areaLabels = await db
      .select({ code: labels.code })
      .from(labels)
      .where(eq(labels.areaId, id))
      .orderBy(asc(labels.code));

    return {
      area: areaJson(
        area,
        cover ? { thumbUrl: thumbUrl(cover), url: photoUrl(cover) } : null,
      ),
      label_codes: areaLabels.map((l) => l.code),
      archived: !!area.archivedAt,
      breadcrumb: crumb,
      deep,
      subareas: subs.map((a) => {
        const c = covers.get(a.id);
        return areaJson(a, c ? { thumbUrl: thumbUrl(c), url: photoUrl(c) } : null, subCounts.get(a.id) ?? 0);
      }),
      items: await Promise.all(contents.map(async (i) => {
        const t = thumbs.get(i.id);
        return {
          id: i.id,
          area_id: i.areaId,
          area_name: deep ? await itemAreaName(i.areaId) : undefined,
          name: i.name,
          description: i.description,
          quantity: i.quantity,
          status: i.status,
          lent_to: i.lentTo,
          not_here_count: i.notHereCount,
          is_private: i.isPrivate,
          thumb: t ? thumbUrl(t) : null,
          photo: t ? photoUrl(t) : null,
        };
      })),
      photos: areaPhotos.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })),
    };
  });

  app.patch('/api/areas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PatchAreaSchema, req.body, reply);
    if (!body) return;
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');
    const evs: { type: 'area.moved' | 'area.updated'; payload: Record<string, unknown> }[] = [];

    if (body.parent_id !== undefined && body.parent_id !== area.parentId) {
      if (body.parent_id === id) return reply.badRequest('an area cannot contain itself');
      if (body.parent_id) {
        const [parent] = await db.select().from(areas).where(eq(areas.id, body.parent_id));
        if (!parent) return reply.badRequest('parent area not found');
        // Reject moving into own descendant.
        const chain = await breadcrumb(body.parent_id);
        if (chain.some((c) => c.id === id))
          return reply.badRequest('an area cannot move inside itself');
      }
      evs.push({
        type: 'area.moved',
        payload: { from_parent_id: area.parentId, to_parent_id: body.parent_id },
      });
    }
    const prevTags = (area.tags as string[] | null) ?? [];
    const nextTags = body.tags === undefined ? prevTags : (body.tags ?? []);
    if (body.name !== undefined && body.name !== area.name) {
      evs.push({ type: 'area.updated', payload: { prev: { name: area.name } } });
    }
    if (JSON.stringify(nextTags) !== JSON.stringify(prevTags)) {
      evs.push({ type: 'area.updated', payload: { prev: { tags: prevTags }, next: { tags: nextTags } } });
    }
    if (body.category !== undefined && body.category !== area.category) {
      evs.push({ type: 'area.updated', payload: { prev: { category: area.category }, next: { category: body.category } } });
    }

    const { updated, eventIds } = db.transaction((tx) => {
      const ids = evs.map((e) => recordEventTx(tx, e.type, 'area', id, e.payload, req.user?.id).id);
      const [u] = tx
        .update(areas)
        .set({
          name: body.name === undefined ? area.name : body.name,
          parentId: body.parent_id === undefined ? area.parentId : body.parent_id,
          coverPhotoId: body.cover_photo_id === undefined ? area.coverPhotoId : body.cover_photo_id,
          tags: body.tags === undefined ? area.tags : nextTags,
          category: body.category === undefined ? area.category : body.category,
        })
        .where(eq(areas.id, id))
        .returning()
        .all();
      return { updated: u, eventIds: ids };
    });
    return { area: areaJson(updated), event_ids: eventIds };
  });

  // Suggest tags for the bin: most common ai_tags + user tags on its items,
  // minus what's already on the area. Local-AI assisted, no remote calls.
  app.get('/api/areas/:id/suggest-tags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');
    const ids = await descendantAreaIds(id);
    const rows = await db
      .select({ aiTags: items.aiTags, tags: items.tags })
      .from(items)
      .where(
        and(
          inArray(items.areaId, ids),
          isNull(items.hiddenAt),
          itemVisible(req.user?.id ?? null),
        ),
      );
    const have = new Set(((area.tags as string[] | null) ?? []).map((t) => t.toLowerCase()));
    const freq = new Map<string, number>();
    const bump = (t: unknown) => {
      if (typeof t === 'string' && t.trim() && !have.has(t.toLowerCase())) {
        const k = t.trim().toLowerCase();
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    };
    for (const r of rows) {
      for (const t of (r.aiTags as string[] | null) ?? []) bump(t);
      for (const t of (r.tags as string[] | null) ?? []) bump(t);
    }
    const suggestions = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    return { suggestions };
  });

  // Merge this area into another: items, sub-areas, and label codes all
  // move; the source is archived. Fully undoable via the recorded ids.
  app.post('/api/areas/:id/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { into_id } = (req.body ?? {}) as { into_id?: string };
    if (!into_id || into_id === id) return reply.badRequest('into_id required (and must differ)');
    const [src] = await db.select().from(areas).where(eq(areas.id, id));
    const [dst] = await db.select().from(areas).where(eq(areas.id, into_id));
    if (!src || src.archivedAt) return reply.notFound('area not found');
    if (!dst || dst.archivedAt) return reply.badRequest('destination area not found');
    const chain = await breadcrumb(into_id);
    if (chain.some((c) => c.id === id)) return reply.badRequest('cannot merge into a descendant');

    const itemIds = (await db.select({ id: items.id }).from(items).where(eq(items.areaId, id))).map((r) => r.id);
    const subIds = (await db.select({ id: areas.id }).from(areas).where(eq(areas.parentId, id))).map((r) => r.id);
    const labelCodes = (await db.select({ code: labels.code }).from(labels).where(eq(labels.areaId, id))).map((r) => r.code);

    const ev = db.transaction((tx) => {
      if (itemIds.length) tx.update(items).set({ areaId: into_id }).where(inArray(items.id, itemIds)).run();
      if (subIds.length) tx.update(areas).set({ parentId: into_id }).where(inArray(areas.id, subIds)).run();
      if (labelCodes.length) tx.update(labels).set({ areaId: into_id }).where(inArray(labels.code, labelCodes)).run();
      tx.update(areas).set({ archivedAt: new Date(), labelCode: null }).where(eq(areas.id, id)).run();
      return recordEventTx(tx, 'area.merged', 'area', id, {
        into_id, name: src.name, item_ids: itemIds, subarea_ids: subIds, label_codes: labelCodes,
      }, req.user?.id);
    });
    return { ok: true, event_id: ev.id, into: { id: dst.id, name: dst.name } };
  });

  // Archive (soft delete). The label is freed - it becomes unclaimed again
  // so a reorganized bin can re-claim the same printed sticker.
  app.delete('/api/areas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');
    const ev = db.transaction((tx) => {
      tx.update(areas).set({ archivedAt: new Date() }).where(eq(areas.id, id)).run();
      tx.update(labels).set({ areaId: null }).where(eq(labels.areaId, id)).run();
      return recordEventTx(tx, 'area.archived', 'area', id, { name: area.name }, req.user?.id);
    });
    return { ok: true, event_id: ev.id };
  });

  // Restore an archived area - inverse of archive, undoable.
  app.post('/api/areas/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');
    const ev = db.transaction((tx) => {
      tx.update(areas).set({ archivedAt: null }).where(eq(areas.id, id)).run();
      return recordEventTx(tx, 'area.restored', 'area', id, { name: area.name }, req.user?.id);
    });
    return { ok: true, event_id: ev.id };
  });

  // Stocktake: tick what's actually here - ticked items go home, the rest are
  // marked unaccounted. One event, one undo.
  app.post('/api/areas/:id/stocktake', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(StocktakeSchema, req.body, reply);
    if (!body) return;
    const { present_ids } = body;
    const markUnaccounted = body.mark_unaccounted !== false;
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');
    const present = new Set(present_ids);
    const contents = await db
      .select()
      .from(items)
      .where(and(eq(items.areaId, id), isNull(items.hiddenAt), itemVisible(req.user?.id ?? null)));

    const changes: { id: string; prev: Record<string, unknown>; next: string }[] = [];
    const now = new Date();
    const eventId = db.transaction((tx) => {
      for (const i of contents) {
        const isPresent = present.has(i.id);
        // No-ops: ticked+home, or absent with an explained status already.
        if (isPresent && i.status === 'home') continue;
        if (!isPresent && (!markUnaccounted || i.status !== 'home')) continue;
        const prev = {
          status: i.status,
          lent_to: i.lentTo,
          out_since: i.outSince,
          hidden_at: i.hiddenAt,
          not_here_count: i.notHereCount,
        };
        tx.update(items)
          .set(
            isPresent
              ? { status: 'home', lentTo: null, outSince: null }
              : {
                  status: 'unaccounted',
                  notHereCount: i.notHereCount + 1,
                  outSince: i.outSince ?? now,
                },
          )
          .where(eq(items.id, i.id))
          .run();
        changes.push({ id: i.id, prev, next: isPresent ? 'home' : 'unaccounted' });
      }
      tx.update(areas).set({ lastAuditAt: now }).where(eq(areas.id, id)).run();
      if (!changes.length) return null;
      return recordEventTx(
        tx, 'stocktake', 'multi', id, { changes, area_id: id }, req.user?.id,
      ).id;
    });
    return { ok: true, changed: changes.length, event_id: eventId };
  });

  // Upload a photo for an area; `cover` field marks it as the cover.
  app.post('/api/areas/:id/photos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area) return reply.notFound('area not found');

    // Collect + validate every file before writing anything - a bad upload
    // must not leave earlier photos half-committed.
    const bufs: Buffer[] = [];
    let wantsCover = !area.coverPhotoId;
    for await (const part of req.parts()) {
      if (part.type === 'file') bufs.push(await part.toBuffer());
      else if (part.fieldname === 'cover' && part.value === 'true') wantsCover = true;
    }
    if (bufs.length === 0) return reply.badRequest('no photo uploaded');
    for (const buf of bufs) {
      try {
        await assertImage(buf);
      } catch (e) {
        if (e instanceof PhotoBusyError) return reply.code(503).send('image processing busy');
        return reply.badRequest('invalid or oversized image');
      }
    }
    // Everything decodes - persist rows + cover in one synchronous tx
    // (better-sqlite3 transactions can't await). If any part fails, the tx
    // rolls back every row and the cover change; files this request wrote
    // are removed below. Pre-existing photos and an existing cover are
    // untouched.
    const saved: SavedPhoto[] = [];
    let savedPhotos: any[] = [];
    try {
      for (const buf of bufs) saved.push(await savePhotoFile(buf));
      savedPhotos = db.transaction((tx) => {
        const rows: any[] = [];
        for (const s of saved) {
          rows.push(
            tx
              .insert(photos)
              .values({ ...s, itemId: null, areaId: id })
              .returning()
              .get(),
          );
        }
        if (wantsCover) {
          tx.update(areas).set({ coverPhotoId: rows[0].id }).where(eq(areas.id, id)).run();
        }
        return rows;
      });
    } catch (e) {
      for (const s of saved) await removePhotoFiles(s);
      throw e;
    }
    return reply.code(201).send({
      photos: savedPhotos.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })),
    });
  });
}
