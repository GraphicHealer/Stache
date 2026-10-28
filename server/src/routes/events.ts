import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { events, items } from '../db/schema';
import { undoEvent } from '../lib/events';
import { itemVisible } from '../lib/visibility';

/** Item events on other users' private items must not leak names/payloads. */
async function eventVisibleToUser(
  entityType: string | null,
  entityId: string | null,
  userId: string | null,
): Promise<boolean> {
  if (entityType !== 'item' || !entityId) return true;
  const [it] = await db
    .select({ isPrivate: items.isPrivate, ownerId: items.ownerId })
    .from(items)
    .where(eq(items.id, entityId));
  if (!it) return true;
  return !it.isPrivate || it.ownerId === userId;
}
import { thumbsForItems, thumbUrl } from '../lib/photos';
import { breadcrumb } from '../lib/breadcrumb';
import { fetchLowStock, fetchWarrantyExpiring } from '../lib/digest';

export async function miscRoutes(app: FastifyInstance) {
  // Recent undoable actions (also powers the "what just happened" history).
  app.get('/api/events', async (req) => {
    const { limit } = req.query as { limit?: string };
    const uid = req.user?.id ?? null;
    const rows = await db
      .select()
      .from(events)
      .orderBy(desc(events.createdAt))
      .limit(Math.min(100, parseInt(limit ?? '30', 10) || 30));
    const visible = [];
    for (const e of rows) {
      if (await eventVisibleToUser(e.entityType, e.entityId, uid)) visible.push(e);
    }
    return {
      events: visible.map((e) => ({
        id: e.id,
        type: e.type,
        entity_type: e.entityType,
        entity_id: e.entityId,
        payload: e.payload,
        undone: !!e.undoneAt,
        created_at: e.createdAt,
      })),
    };
  });

  app.post('/api/events/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [ev] = await db.select().from(events).where(eq(events.id, id));
    if (!ev || !(await eventVisibleToUser(ev.entityType, ev.entityId, req.user?.id ?? null)))
      return reply.notFound('event not found');
    const result = await undoEvent(id);
    if (!result.ok) return reply.badRequest(result.message ?? 'cannot undo');
    return { ok: true };
  });

  // Unnamed items awaiting optional triage. Skipping it forever is fine.
  app.get('/api/inbox', async (req) => {
    const rows = await db
      .select()
      .from(items)
      .where(and(isNull(items.name), isNull(items.hiddenAt), itemVisible(req.user?.id ?? null)))
      .orderBy(desc(items.createdAt))
      .limit(60);
    const thumbs = await thumbsForItems(rows.map((i) => i.id));
    const crumbs = new Map<string, string>();
    for (const i of rows) {
      if (!crumbs.has(i.areaId)) {
        const c = await breadcrumb(i.areaId);
        crumbs.set(i.areaId, c.map((x) => x.name ?? '?').join(' › '));
      }
    }
    // Gently: things marked out or lent - never a nag, just a list.
    const out = await db
      .select()
      .from(items)
      .where(and(ne(items.status, 'home'), isNull(items.hiddenAt), itemVisible(req.user?.id ?? null)))
      .orderBy(asc(items.outSince));
    const outThumbs = await thumbsForItems(out.map((i) => i.id));
    for (const i of out) {
      if (!crumbs.has(i.areaId)) {
        const c = await breadcrumb(i.areaId);
        crumbs.set(i.areaId, c.map((x) => x.name ?? '?').join(' › '));
      }
    }

    // Quiet notices: low stock + warranties ending soon. Optional data only.
    const uid = req.user?.id ?? null;
    const low = await fetchLowStock(uid);
    const expiring = await fetchWarrantyExpiring(uid);
    const miscThumbs = await thumbsForItems([...low, ...expiring].map((i) => i.id));
    for (const i of [...low, ...expiring]) {
      if (!crumbs.has(i.areaId)) {
        const c = await breadcrumb(i.areaId);
        crumbs.set(i.areaId, c.map((x) => x.name ?? '?').join(' › '));
      }
    }

    return {
      items: rows.map((i) => {
        const t = thumbs.get(i.id);
        return {
          id: i.id,
          area_id: i.areaId,
          name: i.name,
          description: i.description,
          quantity: i.quantity,
          ai_name: i.aiName,
          thumb: t ? thumbUrl(t) : null,
          created_at: i.createdAt,
          area_path: crumbs.get(i.areaId) ?? '',
        };
      }),
      lent_out: out.map((i) => {
        const t = outThumbs.get(i.id);
        return {
          id: i.id,
          name: i.name,
          status: i.status,
          lent_to: i.lentTo,
          out_since: i.outSince,
          area_path: crumbs.get(i.areaId) ?? '',
          thumb: t ? thumbUrl(t) : null,
        };
      }),
      low_stock: low.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        restock_below: i.restockBelow,
        area_path: crumbs.get(i.areaId) ?? '',
        thumb: (t => t ? thumbUrl(t) : null)(miscThumbs.get(i.id)),
      })),
      warranty_expiring: expiring.map((i) => ({
        id: i.id,
        name: i.name,
        warranty_until: i.warrantyUntil,
        area_path: crumbs.get(i.areaId) ?? '',
        thumb: (t => t ? thumbUrl(t) : null)(miscThumbs.get(i.id)),
      })),
    };
  });
}
