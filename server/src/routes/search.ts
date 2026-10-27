import type { FastifyInstance } from 'fastify';
import { sql } from '../db';
import { breadcrumb } from '../lib/breadcrumb';
import { thumbsForItems, thumbUrl, photoUrl, coverThumbsForAreas } from '../lib/photos';
import { embedImage, embedText, mlHealthy, nearestByVector } from '../lib/ml';

export async function searchRoutes(app: FastifyInstance) {
  // ?q= fuzzy/full-text  ·  ?barcode= exact product match ("do I own this?")
  app.get('/api/search', async (req, reply) => {
    const { q, barcode } = req.query as { q?: string; barcode?: string };
    const uid = req.user?.id ?? null;

    if (barcode) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM items
        WHERE barcode = ${barcode} AND hidden_at IS NULL
          AND (is_private = false OR owner_id = ${uid})
        LIMIT 50`;
      return { items: await hydrateItems(rows.map((r) => r.id), uid), areas: [] };
    }

    const query = (q ?? '').trim();
    if (!query) return reply.badRequest('q or barcode is required');

    const itemRows = await sql<{ id: string; score: number }[]>`
      SELECT i.id,
             ts_rank(i.search_vector, websearch_to_tsquery('english', ${query}))
               + greatest(similarity(coalesce(i.name, ''), ${query}),
                          word_similarity(${query}, coalesce(i.name, '')),
                          word_similarity(${query}, coalesce(i.description, ''))) AS score
      FROM items i
      WHERE i.hidden_at IS NULL
        AND (i.is_private = false OR i.owner_id = ${uid})
        AND (i.search_vector @@ websearch_to_tsquery('english', ${query})
             OR i.name ILIKE ${'%' + query + '%'}
             OR i.description ILIKE ${'%' + query + '%'}
             OR word_similarity(${query}, coalesce(i.name, '')) > 0.3
             OR word_similarity(${query}, coalesce(i.description, '')) > 0.3
             OR EXISTS (
                  SELECT 1 FROM unnest(string_to_array(lower(coalesce(i.name, '')), ' ')) w
                  WHERE levenshtein(w, lower(${query})) <= 2
                     OR difference(w, lower(${query})) = 4)
             OR i.barcode = ${query})
      ORDER BY score DESC
      LIMIT 50`;

    const areaRows = await sql<{ id: string }[]>`
      SELECT id FROM areas
      WHERE archived_at IS NULL AND name IS NOT NULL
        AND (name ILIKE ${'%' + query + '%'}
             OR word_similarity(${query}, name) > 0.3
             OR EXISTS (
                  SELECT 1 FROM unnest(string_to_array(lower(name), ' ')) w
                  WHERE levenshtein(w, lower(${query})) <= 2
                     OR difference(w, lower(${query})) = 4))
      ORDER BY word_similarity(${query}, name) DESC
      LIMIT 20`;

    const areaList = areaRows.length
      ? await sql<{ id: string; name: string | null; cover_photo_id: string | null }[]>`
          SELECT id, name, cover_photo_id FROM areas WHERE id IN ${sql(areaRows.map((r) => r.id))}`
      : [];
    const covers = await coverThumbsForAreas(
      areaList.map((a) => ({ id: a.id, coverPhotoId: a.cover_photo_id })),
    );

    // CLIP text embedding — catches "looks like" queries text can't.
    let itemIds = itemRows.map((r) => r.id);
    if (await mlHealthy()) {
      try {
        const vec = await embedText(query);
        const similar = (await nearestByVector(vec, 12, uid)).filter((n) => 1 - n.dist > 0.22);
        const seen = new Set(itemIds);
        itemIds = itemIds.concat(similar.filter((n) => !seen.has(n.id)).map((n) => n.id));
      } catch {
        /* embeddings unavailable — text matches still returned */
      }
    }

    return {
      items: await hydrateItems(itemIds, uid),
      areas: areaList.map((a) => {
        const c = covers.get(a.id);
        return { id: a.id, name: a.name, cover_thumb: c ? thumbUrl(c) : null };
      }),
    };
  });

  // Search by photo — "find things like this".
  app.post('/api/search/photo', async (req, reply) => {
    if (!(await mlHealthy())) return reply.badRequest('ML service not available');
    let buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') buf = await part.toBuffer();
    }
    if (!buf) return reply.badRequest('no photo uploaded');
    const vec = await embedImage(buf);
    const neighbors = (await nearestByVector(vec, 25, req.user?.id ?? null)).filter((n) => 1 - n.dist > 0.2);
    return { items: await hydrateItems(neighbors.map((n) => n.id), req.user?.id ?? null), areas: [] };
  });
}

async function hydrateItems(ids: string[], userId: string | null = null) {
  if (!ids.length) return [];
  const rows = await sql<
    {
      id: string; area_id: string; name: string | null; description: string | null;
      quantity: number; status: string; lent_to: string | null; not_here_count: number;
      is_private: boolean;
    }[]
  >`SELECT id, area_id, name, description, quantity, status, lent_to, not_here_count, is_private
    FROM items WHERE id IN ${sql(ids)}
    AND (is_private = false OR owner_id = ${userId})`;
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const thumbs = await thumbsForItems(ids);
  return Promise.all(
    rows.map(async (i) => {
      const t = thumbs.get(i.id);
      return {
        id: i.id,
        area_id: i.area_id,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        status: i.status,
        lent_to: i.lent_to,
        not_here_count: i.not_here_count,
        is_private: i.is_private,
        thumb: t ? thumbUrl(t) : null,
        photo: t ? photoUrl(t) : null,
        breadcrumb: await breadcrumb(i.area_id),
      };
    }),
  );
}
