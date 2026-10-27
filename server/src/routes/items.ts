import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, sql as pg } from '../db';
import { items, photos } from '../db/schema';
import { breadcrumb } from '../lib/breadcrumb';
import { recordEvent } from '../lib/events';
import { insertPhoto, photoUrl, savePhotoFile, thumbUrl, thumbsForItems } from '../lib/photos';
import { kickAi, maybeQueueItem } from '../lib/ai';
import { analyzeItemPhoto, mlHealthy, nearestToItem } from '../lib/ml';
import { detectCodes, lookupBarcode, type DetectedCode } from '../lib/barcodes';

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
    ai_name: i.aiName,
    ai_description: i.aiDescription,
    ai_tags: i.aiTags,
    ai_status: i.aiStatus,
  };
}

export async function itemRoutes(app: FastifyInstance) {
  // File an item. Accepts multipart (photo files + fields) — the normal path —
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
    const [area] = await pg`SELECT id FROM areas WHERE id = ${areaId} AND archived_at IS NULL`;
    if (!area) return reply.badRequest('area not found');

    const [item] = await db
      .insert(items)
      .values({
        areaId,
        name: fields.name || null,
        description: fields.description || null,
        quantity: Math.max(1, parseInt(fields.quantity ?? '1', 10) || 1),
        barcode: fields.barcode || null,
      })
      .returning();

    for (const buf of files) {
      const saved = await savePhotoFile(buf);
      const p = await insertPhoto(saved, { itemId: item.id });
      analyzeItemPhoto(item.id, p.path).catch((e) =>
        console.error('[ml] analyze failed:', e.message),
      );
    }

    const ev = await recordEvent('item.filed', 'item', item.id, { area_id: areaId });
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
    if (!item) return reply.notFound('item not found');
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
    const body = (req.body ?? {}) as Record<string, any>;
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound('item not found');
    const eventIds: string[] = [];

    // Move to another area.
    if (body.area_id !== undefined && body.area_id !== item.areaId) {
      const [area] = await pg`SELECT id FROM areas WHERE id = ${body.area_id} AND archived_at IS NULL`;
      if (!area) return reply.badRequest('destination area not found');
      const ev = await recordEvent('item.moved', 'item', id, {
        from_area_id: item.areaId,
        to_area_id: body.area_id,
      });
      eventIds.push(ev.id);
      item.areaId = body.area_id;
    }

    // Take out / lend / bring home.
    if (body.status !== undefined && body.status !== item.status) {
      if (!['home', 'out', 'lent'].includes(body.status))
        return reply.badRequest('status must be home|out|lent');
      const ev = await recordEvent('item.status', 'item', id, {
        prev: { status: item.status, lent_to: item.lentTo, out_since: item.outSince },
        next: { status: body.status, lent_to: body.lent_to ?? null },
      });
      eventIds.push(ev.id);
      item.status = body.status;
      item.lentTo = body.status === 'lent' ? (body.lent_to ?? item.lentTo) : null;
      item.outSince = body.status === 'home' ? null : new Date();
    }

    const editable = {
      name: 'name',
      description: 'description',
      quantity: 'quantity',
      barcode: 'barcode',
      detected_codes: 'detectedCodes',
    } as const;
    const prev: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(editable)) {
      if (body[key] !== undefined && body[key] !== (item as any)[col]) {
        prev[col] = (item as any)[col];
        next[col] = body[key];
        (item as any)[col] = key === 'quantity' ? Math.max(1, parseInt(body[key], 10) || 1) : body[key];
      }
    }
    if (Object.keys(prev).length) {
      const ev = await recordEvent('item.updated', 'item', id, { prev, next });
      eventIds.push(ev.id);
    }

    const [updated] = await db
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
      })
      .where(eq(items.id, id))
      .returning();
    return { item: itemJson(updated), event_ids: eventIds };
  });

  app.post('/api/items/:id/photos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound('item not found');
    const saved = [];
    const bufs: Buffer[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        bufs.push(buf);
        const p = await insertPhoto(await savePhotoFile(buf), { itemId: id });
        saved.push(p);
        analyzeItemPhoto(id, p.path).catch((e) => console.error('[ml] analyze failed:', e.message));
      }
    }
    if (!saved.length) return reply.badRequest('no photo uploaded');
    detectAndStore(id, bufs).catch(() => {});
    return reply
      .code(201)
      .send({ photos: saved.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })) });
  });

  // "Not here" — lowers confidence and suggests where else to look.
  app.post('/api/items/:id/not-here', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound('item not found');

    const ev = await recordEvent('item.not_here', 'item', id, {
      count_before: item.notHereCount,
      area_id: item.areaId,
    });
    const [updated] = await db
      .update(items)
      .set({ notHereCount: item.notHereCount + 1 })
      .where(eq(items.id, id))
      .returning();

    // Suggest: areas it lived in before (from move events) + siblings of current area.
    const prevAreas = await pg<{ area_id: string }[]>`
      SELECT DISTINCT payload->>'from_area_id' AS area_id
      FROM events
      WHERE type = 'item.moved' AND entity_id = ${id} AND undone_at IS NULL`;
    const siblings = await pg<{ area_id: string }[]>`
      SELECT id AS area_id FROM areas
      WHERE archived_at IS NULL AND parent_id IS NOT DISTINCT FROM
        (SELECT parent_id FROM areas WHERE id = ${item.areaId})
        AND id <> ${item.areaId}
      LIMIT 6`;
    const ids = [...new Set([...prevAreas, ...siblings].map((r) => r.area_id).filter(Boolean))];
    const suggested = ids.length
      ? await pg`SELECT id, name FROM areas WHERE id IN ${pg(ids)} AND archived_at IS NULL`
      : [];

    return { item: itemJson(updated), suggested_areas: suggested, event_id: ev.id };
  });

  // Visually similar items via CLIP embeddings.
  app.get('/api/items/:id/similar', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound('item not found');
    if (!(await mlHealthy())) return { items: [], ml: false };
    const neighbors = await nearestToItem(id, 12);
    const thumbs = await thumbsForItems(neighbors.map((n) => n.id));
    const meta = neighbors.length
      ? await pg`SELECT id, name, area_id, quantity, status FROM items WHERE id IN ${pg(neighbors.map((n) => n.id))}`
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

  // Free external product lookup for a scanned/found barcode.
  app.get('/api/codes/:code/lookup', async (req, reply) => {
    const { code } = req.params as { code: string };
    const product = await lookupBarcode(code);
    return { code, product };
  });

  // Hide (soft delete) — undoable.
  app.delete('/api/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound('item not found');
    await db.update(items).set({ hiddenAt: new Date() }).where(eq(items.id, id));
    const ev = await recordEvent('item.hidden', 'item', id, { name: item.name });
    return { ok: true, event_id: ev.id };
  });
}
