import type { FastifyInstance } from 'fastify';
import { and, asc, desc, isNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { events, items } from '../db/schema';
import { undoEvent } from '../lib/events';
import { itemVisible } from '../lib/visibility';
import { thumbsForItems, thumbUrl } from '../lib/photos';
import { breadcrumb } from '../lib/breadcrumb';

export async function miscRoutes(app: FastifyInstance) {
  // Recent undoable actions (also powers the "what just happened" history).
  app.get('/api/events', async (req) => {
    const { limit } = req.query as { limit?: string };
    const rows = await db
      .select()
      .from(events)
      .orderBy(desc(events.createdAt))
      .limit(Math.min(100, parseInt(limit ?? '30', 10) || 30));
    return {
      events: rows.map((e) => ({
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
    };
  });
}
