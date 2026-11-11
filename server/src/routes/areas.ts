import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { env } from '../env';
import { areas, labels, objectShares, photos, user } from '../db/schema';
import { breadcrumb, descendantAreaIds, directItemCounts, subtreeItemCounts } from '../lib/breadcrumb';
import { recordEventTx } from '../lib/events';
import {
  assertImage,
  coverGridForAreas,
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
import { areaVisible, canSeeArea } from '../lib/visibility';
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
  is_private: z.boolean().optional(),
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
  ownCount?: number,
  coverGrid?: string[],
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
    is_private: a.isPrivate,
    owner_id: a.ownerId,
    last_audit_at: a.lastAuditAt,
    tags: a.tags ?? [],
    category: a.category,
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
    ...(ownCount !== undefined ? { own_count: ownCount } : {}),
    ...(coverGrid?.length ? { cover_grid: coverGrid } : {}),
  };
}

export async function areaRoutes(app: FastifyInstance) {
  // Root areas for browsing; ?all=1 returns every live area (parent pickers).
  app.get('/api/areas', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    const roots = await db
      .select()
      .from(areas)
      .where(and(all ? isNull(areas.archivedAt) : and(isNull(areas.parentId), isNull(areas.archivedAt)), areaVisible(req.user?.id ?? null, req.user?.role === 'admin')))
      .orderBy(asc(areas.createdAt));
    const covers = await coverThumbsForAreas(roots);
    const counts = await subtreeItemCounts(
      roots.map((a) => a.id),
      req.user?.id ?? null,
    );
    const ownCounts = await directItemCounts(roots.map((a) => a.id), req.user?.id ?? null);
    const grids = await coverGridForAreas(roots.filter((a) => !covers.get(a.id)).map((a) => a.id));
    return {
      areas: roots.map((a) => {
        const c = covers.get(a.id);
        return areaJson(a, c ? { thumbUrl: thumbUrl(c), url: photoUrl(c) } : null, counts.get(a.id) ?? 0, ownCounts.get(a.id) ?? 0, grids.get(a.id)?.map((p) => thumbUrl(p)));
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');

    const scopeIds = deep ? await descendantAreaIds(id) : [id];
    const [crumb, subs, contents, areaPhotos] = await Promise.all([
      breadcrumb(id),
      db
        .select()
        .from(areas)
        .where(and(eq(areas.parentId, id), isNull(areas.archivedAt), areaVisible(req.user?.id ?? null, req.user?.role === 'admin')))
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
    const ownCounts = await directItemCounts(subs.map((a) => a.id), req.user?.id ?? null);
    const subGrids = await coverGridForAreas(subs.filter((a) => !covers.get(a.id)).map((a) => a.id));
    const thumbs = await thumbsForItems(contents.map((i) => i.id));
    // The page header only shows a real cover shot - a placeholder signals
    // "no cover, you can add one" (the album grid is for cards, not here).
    const cover = areaPhotos.find((p) => p.id === area.coverPhotoId) ?? areaPhotos[0] ?? null;
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

    const shareRows = await db
      .select({ userId: objectShares.userId, name: user.name })
      .from(objectShares)
      .leftJoin(user, eq(user.id, objectShares.userId))
      .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, id)));
    return {
      shared_with: shareRows,
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
        return areaJson(a, c ? { thumbUrl: thumbUrl(c), url: photoUrl(c) } : null, subCounts.get(a.id) ?? 0, ownCounts.get(a.id) ?? 0, subGrids.get(a.id)?.map((p) => thumbUrl(p)));
      }),
      items: await Promise.all(contents.map(async (i) => {
        const t = thumbs.get(i.id);
        return {
          id: i.id,
          area_id: i.areaId,
          area_name: deep ? await itemAreaName(i.areaId) : undefined,
          name: i.name,
          ai_name: i.aiName ?? null,
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
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
    let clearedShares: string[] = [];
    if (body.is_private !== undefined && body.is_private !== area.isPrivate) {
      if (!body.is_private && area.ownerId && area.ownerId !== req.user?.id && req.user?.role !== 'admin') {
        return reply.code(403).send('only the owner can un-private a bin');
      }
      if (body.is_private && !area.isPrivate) {
        area.ownerId = area.ownerId ?? req.user?.id ?? null;
      } else {
        clearedShares = (await db
          .select({ userId: objectShares.userId })
          .from(objectShares)
          .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, id)))).map((r) => r.userId);
      }
      evs.push({ type: 'area.updated', payload: { prev: { is_private: area.isPrivate, owner_id: area.ownerId, shares: clearedShares }, next: { is_private: body.is_private } } });
      area.isPrivate = body.is_private;
      if (!body.is_private) area.ownerId = null;
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
          isPrivate: area.isPrivate,
          ownerId: area.ownerId,
        })
        .where(eq(areas.id, id))
        .returning()
        .all();
      if (clearedShares.length) {
        tx.delete(objectShares)
          .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, id)))
          .run();
      }
      return { updated: u, eventIds: ids };
    });
    return { area: areaJson(updated), event_ids: eventIds };
  });

  // Suggest tags for the bin: most common ai_tags + user tags on its items,
  // minus what's already on the area. Local-AI assisted, no remote calls.
  // Share management on a private bin: anyone in the access set (owner or
  // a shared member) can add/remove members. View + manage, no levels.
  app.post('/api/areas/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { user_id?: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
    if (!area.isPrivate) return reply.badRequest('bin is not private');
    if (!(await canManageShare(area.ownerId, req.user?.id ?? null, id))) return reply.code(403).send('not a member of this private bin');
    if (!body.user_id || body.user_id === area.ownerId) return reply.badRequest('pick a member to add');
    const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, body.user_id));
    if (!u) return reply.badRequest('unknown member');
    await db.insert(objectShares).values({ objectType: 'area', objectId: id, userId: body.user_id }).onConflictDoNothing();
    return { ok: true };
  });

  app.delete('/api/areas/:id/shares/:uid', async (req, reply) => {
    const { id, uid } = req.params as { id: string; uid: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
    if (!area.isPrivate) return reply.badRequest('bin is not private');
    if (!(await canManageShare(area.ownerId, req.user?.id ?? null, id))) return reply.code(403).send('not a member of this private bin');
    await db
      .delete(objectShares)
      .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, id), eq(objectShares.userId, uid)));
    return { ok: true };
  });

  app.get('/api/areas/:id/suggest-tags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
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
    if (!src || src.archivedAt || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
    if (!dst || dst.archivedAt || !(await canSeeArea(into_id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.badRequest('destination area not found');
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
    const ev = db.transaction((tx) => {
      tx.update(areas).set({ archivedAt: null }).where(eq(areas.id, id)).run();
      return recordEventTx(tx, 'area.restored', 'area', id, { name: area.name }, req.user?.id);
    });
    return { ok: true, event_id: ev.id };
  });

  // Permanent delete from Trash: archived only, and only when empty -
  // items and sub-areas must be moved or handled first.
  app.delete('/api/areas/:id/purge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [area] = await db.select().from(areas).where(eq(areas.id, id));
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
    if (!area.archivedAt) return reply.badRequest('only archived areas can be purged');
    const [item] = await db.select().from(items).where(eq(items.areaId, id)).limit(1);
    if (item) return reply.badRequest('area still has items - move or purge them first');
    const [child] = await db.select().from(areas).where(eq(areas.parentId, id)).limit(1);
    if (child) return reply.badRequest('area still has sub-areas - move them first');
    const pics = await db.select().from(photos).where(eq(photos.areaId, id));
    db.transaction((tx) => {
      tx.delete(photos).where(eq(photos.areaId, id)).run();
      tx.delete(objectShares).where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, id))).run();
      tx.delete(areas).where(eq(areas.id, id)).run();
    });
    for (const p of pics) {
      for (const f of [p.path, p.thumbPath].filter(Boolean)) {
        fs.rm(path.join(env.dataDir, 'photos', f!), { force: true }).catch(() => {});
      }
    }
    return { ok: true };
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');
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
    if (!area || !(await canSeeArea(id, req.user?.id ?? null, req.user?.role === 'admin'))) return reply.notFound('area not found');

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


/** Access-set check for share management: owner or an existing share. */
async function canManageShare(ownerId: string | null, userId: string | null, areaId: string) {
  if (!userId) return false;
  if (ownerId === userId) return true;
  const [row] = await db
    .select()
    .from(objectShares)
    .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, areaId), eq(objectShares.userId, userId)))
    .limit(1);
  return !!row;
}
