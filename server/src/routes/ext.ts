// External REST API (/api/v1/*) - bearer-token surface for integrations like
// Home Assistant. Mirrors the session API's semantics: same event payloads so
// undo works identically, shared items only (private items are never exposed).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { apiTokens, areas, items, labels, photos, type ApiToken } from '../db/schema';
import { recordEvent, recordEventTx } from '../lib/events';
import { assertImage, insertPhoto, photoUrl, savePhotoFile, thumbUrl, PhotoBusyError } from '../lib/photos';
import { analyzeItemPhoto } from '../lib/ml';
import { detectAndStore } from './items';
import { kickAi, maybeQueueItem } from '../lib/ai';
import { parseBody } from '../lib/validate';
import { badAiUrl, checkedLookup } from '../lib/urlcheck';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import crypto from 'node:crypto';

// Outbound fetches (photo_url) refuse link-local/metadata targets even on
// rebind - same checkedLookup the AI client uses.
const extDispatcher = new Agent({ connect: { lookup: checkedLookup() } as any });

const TokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(['read', 'read-write']).optional(),
});

const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

type ApiCtx = { tok: ApiToken };

/** Bearer auth for /api/v1/* - resolves the token or sends 401 and returns null. */
async function apiAuth(req: FastifyRequest, reply: FastifyReply, write = false): Promise<ApiCtx | null> {
  const authz = req.headers.authorization ?? '';
  if (!authz.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'unauthorized', detail: 'Bearer token required' });
    return null;
  }
  const [tok] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash(authz.slice(7))));
  if (!tok) {
    reply.code(401).send({ error: 'unauthorized', detail: 'invalid token' });
    return null;
  }
  if (write && tok.scope !== 'read-write') {
    reply.code(403).send({ error: 'forbidden', detail: 'token is read-only' });
    return null;
  }
  db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tok.id)).catch(() => {});
  return { tok };
}

const actor = (tok: ApiToken) => `api:${tok.name}`;

// API tokens see shared items only - same boundary as MCP.
const itemJson = (i: typeof items.$inferSelect) => ({
  id: i.id,
  area_id: i.areaId,
  name: i.name,
  description: i.description,
  quantity: i.quantity,
  barcode: i.barcode,
  tags: i.tags,
  status: i.status,
  lent_to: i.lentTo,
  out_since: i.outSince,
  ai_name: i.aiName,
  ai_description: i.aiDescription,
  ai_tags: i.aiTags,
  created_at: i.createdAt,
});

const areaJson = (a: typeof areas.$inferSelect, counts = new Map<string, number>()) => ({
  id: a.id,
  name: a.name,
  parent_id: a.parentId,
  category: a.category,
  item_count: counts.get(a.id) ?? 0,
});

/** Resolve an area ref: id, label code, or exact name (find-or-create on name). */
async function resolveArea(ref: { area_id?: string; area_label?: string; area_name?: string }) {
  if (ref.area_id) {
    const [a] = await db.select().from(areas).where(and(eq(areas.id, ref.area_id), isNull(areas.archivedAt)));
    return a ?? null;
  }
  if (ref.area_label) {
    const [l] = await db.select().from(labels).where(eq(labels.code, ref.area_label.toUpperCase()));
    if (!l?.areaId) return null;
    const [a] = await db.select().from(areas).where(and(eq(areas.id, l.areaId), isNull(areas.archivedAt)));
    return a ?? null;
  }
  if (ref.area_name) {
    const [a] = await db.select().from(areas).where(and(eq(areas.name, ref.area_name), isNull(areas.archivedAt)));
    if (a) return a;
    const [created] = await db.insert(areas).values({ name: ref.area_name.trim() }).returning();
    await recordEvent('area.created', 'area', created.id, { name: created.name }, null, 'api');
    return created;
  }
  return null;
}

export async function extRoutes(app: FastifyInstance) {
  // --- Token management (session-guarded like /api/settings/mcp) -------------

  app.get('/api/settings/api-tokens', async () => ({
    tokens: (await db.select().from(apiTokens).orderBy(asc(apiTokens.createdAt))).map(
      ({ tokenHash: _h, ...t }) => t,
    ),
  }));

  app.post('/api/settings/api-tokens', async (req, reply) => {
    const body = parseBody(TokenCreateSchema, req.body, reply);
    if (!body) return;
    const token = crypto.randomBytes(24).toString('base64url');
    const [row] = await db
      .insert(apiTokens)
      .values({ name: body.name.trim(), tokenHash: hash(token), scope: body.scope ?? 'read-write' })
      .returning();
    const { tokenHash: _h, ...pub } = row;
    return reply.code(201).send({ token: pub, secret: token });
  });

  app.delete('/api/settings/api-tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(apiTokens).where(eq(apiTokens.id, id));
    return { ok: true };
  });

  // --- Reads ---------------------------------------------------------------

  app.get('/api/v1/areas', async (req, reply) => {
    const ctx = await apiAuth(req, reply);
    if (!ctx) return;
    const rows = await db.select().from(areas).where(isNull(areas.archivedAt)).orderBy(asc(areas.name));
    const counts = new Map<string, number>();
    for (const i of await db.select({ areaId: items.areaId }).from(items).where(eq(items.isPrivate, false))) {
      if (i.areaId) counts.set(i.areaId, (counts.get(i.areaId) ?? 0) + 1);
    }
    return { areas: rows.map((a) => areaJson(a, counts)) };
  });

  app.get('/api/v1/areas/:id', async (req, reply) => {
    const ctx = await apiAuth(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const [a] = await db.select().from(areas).where(and(eq(areas.id, id), isNull(areas.archivedAt)));
    if (!a) return reply.notFound('area not found');
    const contents = await db
      .select()
      .from(items)
      .where(and(eq(items.areaId, id), eq(items.isPrivate, false), isNull(items.hiddenAt)))
      .orderBy(asc(items.createdAt));
    return { area: areaJson(a), items: contents.map(itemJson) };
  });

  app.get('/api/v1/items', async (req, reply) => {
    const ctx = await apiAuth(req, reply);
    if (!ctx) return;
    const q = ((req.query as { q?: string }).q ?? '').trim().toLowerCase();
    const rows = await db
      .select()
      .from(items)
      .where(and(eq(items.isPrivate, false), isNull(items.hiddenAt)))
      .orderBy(asc(items.createdAt));
    const matched = q
      ? rows.filter((i) =>
          [i.name, i.description, i.barcode, (i.tags as string[] | null)?.join(' ')].some(
            (f) => f && String(f).toLowerCase().includes(q),
          ),
        )
      : rows;
    return { items: matched.slice(0, 50).map(itemJson), total: matched.length };
  });

  app.get('/api/v1/items/:id', async (req, reply) => {
    const ctx = await apiAuth(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(and(eq(items.id, id), eq(items.isPrivate, false)));
    if (!item) return reply.notFound('item not found');
    const itemPhotos = await db.select().from(photos).where(eq(photos.itemId, id)).orderBy(asc(photos.createdAt));
    return {
      item: itemJson(item),
      photos: itemPhotos.map((p) => ({ id: p.id, url: photoUrl(p), thumb: thumbUrl(p) })),
    };
  });

  app.get('/api/v1/labels/:code', async (req, reply) => {
    const ctx = await apiAuth(req, reply);
    if (!ctx) return;
    const { code } = req.params as { code: string };
    const [l] = await db.select().from(labels).where(eq(labels.code, code.toUpperCase()));
    if (!l) return reply.notFound('unknown label');
    let area = null;
    if (l.areaId) {
      const [a] = await db.select().from(areas).where(eq(areas.id, l.areaId));
      if (a && !a.archivedAt) area = areaJson(a);
    }
    return { label: { code: l.code, printed_at: l.printedAt }, area };
  });

  // --- Writes (read-write scope) --------------------------------------------

  const ItemCreateSchema = z.object({
    area_id: z.string().optional(),
    area_label: z.string().optional(),
    area_name: z.string().optional(),
    name: z.string().max(200).nullish(),
    description: z.string().max(2000).nullish(),
    quantity: z.union([z.number(), z.string()]).optional(),
    barcode: z.string().max(64).nullish(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    photo_url: z.string().url().optional(),
  });

  app.post('/api/v1/items', async (req, reply) => {
    const ctx = await apiAuth(req, reply, true);
    if (!ctx) return;

    const fields: Record<string, unknown> = {};
    const files: Buffer[] = [];
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') files.push(await part.toBuffer());
        else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      }
    } else {
      Object.assign(fields, (req.body ?? {}) as Record<string, unknown>);
    }
    const body = parseBody(ItemCreateSchema, fields, reply);
    if (!body) return;

    for (const buf of files) {
      try {
        await assertImage(buf);
      } catch (e) {
        if (e instanceof PhotoBusyError) return reply.code(503).send('image processing busy');
        return reply.badRequest('invalid or oversized image');
      }
    }

    // Optional remote photo - http(s) only, SSRF-checked, 10s + 25MB cap,
    // validated as an image before it touches the pipeline.
    if (body.photo_url && files.length === 0) {
      const bad = await badAiUrl(body.photo_url);
      if (bad) return reply.badRequest('photo_url is not allowed');
      try {
        const res = await undiciFetch(body.photo_url, {
          signal: AbortSignal.timeout(10_000),
          dispatcher: extDispatcher,
          redirect: 'error', // don't follow redirects into a blocked host
        });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > 25 * 1024 * 1024) throw new Error('too large');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 25 * 1024 * 1024) return reply.badRequest('photo exceeds 25MB');
        await assertImage(buf);
        files.push(buf);
      } catch (e) {
        if (e instanceof PhotoBusyError) return reply.code(503).send('image processing busy');
        return reply.badRequest('photo_url is not a fetchable image');
      }
    }

    const area = await resolveArea(body);
    if (!area) return reply.badRequest('area not found - pass area_id, area_label, or area_name');

    const { item, ev } = db.transaction((tx) => {
      const [i] = tx
        .insert(items)
        .values({
          areaId: area.id,
          name: body.name ?? null,
          description: body.description ?? null,
          quantity: Math.max(1, Number(body.quantity) || 1),
          barcode: body.barcode ?? null,
          tags: body.tags ?? null,
        })
        .returning()
        .all();
      const e = recordEventTx(tx, 'item.filed', 'item', i.id, { area_id: area.id }, null, actor(ctx.tok));
      return { item: i, ev: e };
    });

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

  const ItemPatchSchema = z.object({
    area_id: z.string().optional(),
    name: z.string().max(200).nullish(),
    description: z.string().max(2000).nullish(),
    quantity: z.union([z.number(), z.string()]).optional(),
    barcode: z.string().max(64).nullish(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    status: z.enum(['home', 'out', 'lent', 'unaccounted', 'gone']).optional(),
    lent_to: z.string().max(120).nullish(),
  });

  app.patch('/api/v1/items/:id', async (req, reply) => {
    const ctx = await apiAuth(req, reply, true);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const body = parseBody(ItemPatchSchema, req.body, reply);
    if (!body) return;
    const [item] = await db.select().from(items).where(and(eq(items.id, id), eq(items.isPrivate, false)));
    if (!item) return reply.notFound('item not found');

    const evs: { type: Parameters<typeof recordEventTx>[1]; payload: Record<string, unknown> }[] = [];

    if (body.area_id !== undefined && body.area_id !== item.areaId) {
      const [a] = await db.select({ id: areas.id }).from(areas).where(and(eq(areas.id, body.area_id), isNull(areas.archivedAt)));
      if (!a) return reply.badRequest('area not found');
      evs.push({ type: 'item.moved', payload: { from_area_id: item.areaId, to_area_id: body.area_id } });
      item.areaId = body.area_id;
    }

    if (body.status !== undefined && body.status !== item.status) {
      evs.push({
        type: 'item.status',
        payload: {
          prev: {
            status: item.status,
            lent_to: item.lentTo,
            out_since: item.outSince,
            hidden_at: item.hiddenAt,
            takeout_count: item.takeoutCount,
          },
          next: { status: body.status, lent_to: body.lent_to ?? null },
        },
      });
      const goingOut = ['out', 'lent'].includes(body.status) && item.status === 'home';
      item.status = body.status;
      item.lentTo = body.status === 'lent' ? (body.lent_to ?? item.lentTo) : null;
      if (goingOut) item.takeoutCount = (item.takeoutCount ?? 0) + 1;
      if (body.status === 'home') {
        item.outSince = null;
        item.hiddenAt = null;
      } else if (!item.outSince) {
        item.outSince = new Date();
      }
      if (body.status === 'gone') item.hiddenAt = new Date();
    }

    const prev: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const [key, col] of [
      ['name', 'name'],
      ['description', 'description'],
      ['barcode', 'barcode'],
      ['tags', 'tags'],
    ] as const) {
      if (key in body && JSON.stringify((body as any)[key] ?? null) !== JSON.stringify((item as any)[col] ?? null)) {
        prev[key] = (item as any)[col];
        next[key] = (body as any)[key] ?? null;
        (item as any)[col] = (body as any)[key] ?? null;
      }
    }
    if (body.quantity !== undefined) {
      const q = Math.max(1, Number(body.quantity) || 1);
      if (q !== item.quantity) {
        prev.quantity = item.quantity;
        next.quantity = q;
        item.quantity = q;
      }
    }
    if (Object.keys(prev).length) evs.push({ type: 'item.updated', payload: { prev, next } });

    const { updated, eventIds } = db.transaction((tx) => {
      const ids = evs.map((e) => recordEventTx(tx, e.type, 'item', id, e.payload, null, actor(ctx.tok)).id);
      const [u] = tx
        .update(items)
        .set({
          areaId: item.areaId,
          status: item.status,
          lentTo: item.lentTo,
          outSince: item.outSince,
          hiddenAt: item.hiddenAt,
          takeoutCount: item.takeoutCount,
          name: item.name,
          description: item.description,
          quantity: item.quantity,
          barcode: item.barcode,
          tags: item.tags,
        })
        .where(eq(items.id, id))
        .returning()
        .all();
      return { updated: u, eventIds: ids };
    });
    return { item: itemJson(updated), event_ids: eventIds };
  });

  app.post('/api/v1/items/:id/move', async (req, reply) => {
    const ctx = await apiAuth(req, reply, true);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { area_id?: string; area_label?: string; area_name?: string };
    const [item] = await db.select().from(items).where(and(eq(items.id, id), eq(items.isPrivate, false)));
    if (!item) return reply.notFound('item not found');
    const area = await resolveArea(body);
    if (!area) return reply.badRequest('area not found');
    const { eventId } = db.transaction((tx) => {
      const e = recordEventTx(tx, 'item.moved', 'item', id, { from_area_id: item.areaId, to_area_id: area.id }, null, actor(ctx.tok));
      tx.update(items).set({ areaId: area.id }).where(eq(items.id, id)).run();
      return { eventId: e.id };
    });
    return { ok: true, event_id: eventId };
  });
}
