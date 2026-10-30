import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, query, placeholders } from '../db';
import { items } from '../db/schema';
import { breadcrumb, descendantAreaIds } from '../lib/breadcrumb';
import { thumbsForItems, thumbUrl, photoUrl, coverThumbsForAreas } from '../lib/photos';
import { embedImage, embedText, mlHealthy, nearestByVector, warmClip } from '../lib/ml';
import { searchItemIds, wordSim, trigramSim, levenshtein, soundex } from '../lib/textsearch';

export async function searchRoutes(app: FastifyInstance) {
  // ?q= fuzzy/full-text  ·  ?barcode= exact product match ("do I own this?")
  // Optional filters: &status= &area_id= &private=1
  app.get('/api/search', async (req, reply) => {
    const { q, barcode, status, area_id, private: priv, tag } = req.query as {
      q?: string;
      barcode?: string;
      status?: string;
      area_id?: string;
      private?: string;
      tag?: string;
    };
    const uid = req.user?.id ?? null;
    const tagLc = tag?.trim().toLowerCase() || null;
    const hasFilters = !!(status || area_id || priv || tagLc);
    const tagCond = () =>
      tagLc
        ? query<{ id: string }>(
            `SELECT id FROM items
             WHERE EXISTS (
               SELECT 1 FROM json_each(items.tags)
               WHERE lower(json_each.value) = ?
             )`,
            tagLc,
          ).map((r) => r.id)
        : null;
    // Area filters cover the whole subtree - "in the garage" means anywhere
    // inside it, not just loose on the garage floor.
    const areaScope = area_id ? await descendantAreaIds(area_id) : null;

    // Post-filter matched ids by SQL - keeps result ordering intact.
    const tagIds = tagCond();
    const applyFilters = async (ids: string[]) => {
      if (!hasFilters || !ids.length) return ids;
      const conds = [inArray(items.id, ids)];
      if (status) conds.push(eq(items.status, status));
      if (areaScope) conds.push(inArray(items.areaId, areaScope));
      if (priv === '1') conds.push(eq(items.isPrivate, true));
      if (priv === '0') conds.push(eq(items.isPrivate, false));
      if (tagIds) conds.push(inArray(items.id, tagIds));
      const ok = new Set(
        (await db.select({ id: items.id }).from(items).where(and(...conds))).map((r) => r.id),
      );
      return ids.filter((id) => ok.has(id));
    };

    if (barcode) {
      const rows = query<{ id: string }>(
        `SELECT id FROM items
         WHERE barcode = ? AND hidden_at IS NULL
           AND (is_private = 0 OR owner_id = ?)
         LIMIT 50`,
        barcode,
        uid,
      );
      return { items: await hydrateItems(await applyFilters(rows.map((r) => r.id)), uid), areas: [] };
    }

    const q2 = (q ?? '').trim();
    if (!q2 && !hasFilters) return reply.badRequest('q or barcode is required');
    if (!q2) {
      // Filters-only browse: newest matching items.
      const conds = [
        isNull(items.hiddenAt),
        uid ? or(eq(items.isPrivate, false), eq(items.ownerId, uid))! : eq(items.isPrivate, false),
      ];
      if (status) conds.push(eq(items.status, status));
      if (areaScope) conds.push(inArray(items.areaId, areaScope));
      if (priv === '1') conds.push(eq(items.isPrivate, true));
      if (tagIds) conds.push(inArray(items.id, tagIds));
      const rows = await db
        .select({ id: items.id })
        .from(items)
        .where(and(...conds))
        .orderBy(desc(items.createdAt))
        .limit(50);
      return { items: await hydrateItems(rows.map((r) => r.id), uid), areas: [] };
    }

    const itemRows = searchItemIds(q2, uid);

    // Areas: same fuzzy rules, all in JS - the area table is tiny.
    const lq = q2.toLowerCase();
    const areaRows = query<{ id: string; name: string | null; cover_photo_id: string | null }>(
      `SELECT id, name, cover_photo_id FROM areas WHERE archived_at IS NULL AND name IS NOT NULL`,
    )
      .map((a) => {
        const ln = (a.name ?? '').toLowerCase();
        let score = Math.max(trigramSim(lq, ln), wordSim(lq, ln));
        let matched = score > 0.3 || ln.includes(lq);
        for (const w of ln.split(/[^a-z0-9]+/)) {
          if (w && (levenshtein(w, lq) <= 2 || soundex(w) === soundex(lq))) {
            matched = true;
            score = Math.max(score, 0.45);
            break;
          }
        }
        return { ...a, score, matched };
      })
      .filter((a) => a.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const covers = await coverThumbsForAreas(
      areaRows.map((a) => ({ id: a.id, coverPhotoId: a.cover_photo_id })),
    );

    // CLIP text embedding - catches "looks like" queries text can't. Lazy:
    // the first search kicks a background load instead of blocking on it.
    let itemIds = itemRows.map((r) => r.id);
    if (mlHealthy()) {
      try {
        const vec = await embedText(q2);
        const similar = (await nearestByVector(vec, 12, uid)).filter((n) => 1 - n.dist > 0.22);
        const seen = new Set(itemIds);
        itemIds = itemIds.concat(similar.filter((n) => !seen.has(n.id)).map((n) => n.id));
      } catch {
        /* embeddings unavailable - text matches still returned */
      }
    } else {
      warmClip();
    }

    return {
      items: await hydrateItems(await applyFilters(itemIds), uid),
      areas: areaRows.map((a) => {
        const c = covers.get(a.id);
        return { id: a.id, name: a.name, cover_thumb: c ? thumbUrl(c) : null };
      }),
    };
  });

  // Search by photo - "find things like this". First use lazily loads CLIP.
  app.post('/api/search/photo', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    let buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') buf = await part.toBuffer();
    }
    if (!buf) return reply.badRequest('no photo uploaded');
    let vec: number[];
    try {
      vec = await embedImage(buf);
    } catch {
      return reply.badRequest('ML service not available');
    }
    const neighbors = (await nearestByVector(vec, 25, req.user?.id ?? null)).filter((n) => 1 - n.dist > 0.2);
    return { items: await hydrateItems(neighbors.map((n) => n.id), req.user?.id ?? null), areas: [] };
  });

  // "Recently filed" feed - newest items plus the areas they landed in.
  app.get('/api/recent', async (req) => {
    const uid = req.user?.id ?? null;
    const rows = await db
      .select({ id: items.id, areaId: items.areaId })
      .from(items)
      .where(
        and(
          isNull(items.hiddenAt),
          uid ? or(eq(items.isPrivate, false), eq(items.ownerId, uid))! : eq(items.isPrivate, false),
        ),
      )
      .orderBy(desc(items.createdAt))
      .limit(24);
    return { items: await hydrateItems(rows.map((r) => r.id), uid) };
  });
}

async function hydrateItems(ids: string[], userId: string | null = null) {
  if (!ids.length) return [];
  const visible = userId
    ? or(eq(items.isPrivate, false), eq(items.ownerId, userId))!
    : eq(items.isPrivate, false);
  const rows = await db
    .select({
      id: items.id,
      areaId: items.areaId,
      name: items.name,
      description: items.description,
      quantity: items.quantity,
      status: items.status,
      lentTo: items.lentTo,
      notHereCount: items.notHereCount,
      isPrivate: items.isPrivate,
    })
    .from(items)
    .where(and(inArray(items.id, ids), visible));
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const thumbs = await thumbsForItems(ids);
  return Promise.all(
    rows.map(async (i) => {
      const t = thumbs.get(i.id);
      return {
        id: i.id,
        area_id: i.areaId,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        status: i.status,
        lent_to: i.lentTo,
        not_here_count: i.notHereCount,
        is_private: i.isPrivate,
        thumb: t ? thumbUrl(t) : null,
        photo: t ? photoUrl(t) : null,
        breadcrumb: await breadcrumb(i.areaId),
      };
    }),
  );
}
