import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, queryOne } from '../db';
import { items } from '../db/schema';
import { recordEventTx } from '../lib/events';
import { thumbsForItems, thumbUrl } from '../lib/photos';
import {
  fetchLowStock,
  fetchMissing,
  fetchWarrantyExpiring,
  getDigestConfig,
  outJson,
  sendDigest,
  verifyWebhookToken,
  webhookToken,
} from '../lib/digest';

// Webhook auth: prefer the Authorization header so tokens stay out of URLs
// (and out of request logs); ?token= still works for existing setups.
function requestToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return (req.query as { token?: string }).token;
}

export async function outRoutes(app: FastifyInstance) {
  // Everything removed from its space, split "out" vs "unaccounted for".
  app.get('/api/out', async (req) => {
    const { out, unaccounted } = await fetchMissing(req.user?.id ?? null);
    return {
      out: await outJson(out),
      unaccounted: await outJson(unaccounted),
    };
  });

  // Dashboard widget: newest out items + total. Empty hides the widget.
  app.get('/api/out/summary', async (req) => {
    const uid = req.user?.id ?? null;
    const rows = await db
      .select()
      .from(items)
      .where(
        and(
          isNull(items.hiddenAt),
          inArray(items.status, ['out', 'lent', 'unaccounted']),
          uid ? or(eq(items.isPrivate, false), eq(items.ownerId, uid)) : eq(items.isPrivate, false),
        ),
      )
      .orderBy(desc(items.outSince))
      .limit(7);
    const { n } = queryOne<{ n: number }>(
      `SELECT count(*) AS n FROM items
       WHERE hidden_at IS NULL AND status IN ('out','lent','unaccounted')
         AND (is_private = 0 OR owner_id = ?)`,
      uid,
    ) ?? { n: 0 };
    const thumbs = await thumbsForItems(rows.map((r) => r.id));
    return {
      total: n,
      items: rows.slice(0, 6).map((r) => {
        const t = thumbs.get(r.id);
        return { id: r.id, name: r.name, thumb: t ? thumbUrl(t) : null };
      }),
    };
  });

  // Out items that belong to one area - powers the "mark back?" offer on scan.
  app.get('/api/areas/:id/out', async (req, reply) => {
    const { id } = req.params as { id: string };
    const uid = req.user?.id ?? null;
    const rows = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.areaId, id),
          isNull(items.hiddenAt),
          inArray(items.status, ['out', 'lent', 'unaccounted']),
          uid ? or(eq(items.isPrivate, false), eq(items.ownerId, uid)) : eq(items.isPrivate, false),
        ),
      );
    const thumbs = await thumbsForItems(rows.map((r) => r.id));
    return {
      items: rows.map((r) => {
        const t = thumbs.get(r.id);
        return { id: r.id, name: r.name, status: r.status, thumb: t ? thumbUrl(t) : null };
      }),
    };
  });

  // One-tap put-back, single or bulk. Home = wherever the item already lives.
  app.post('/api/items/put-back', async (req, reply) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!ids?.length) return reply.badRequest('ids required');
    const uid = req.user?.id ?? null;
    const eventIds: string[] = [];
    for (const id of ids) {
      const [item] = await db.select().from(items).where(eq(items.id, id));
      if (!item || (item.isPrivate && item.ownerId !== uid)) continue;
      if (['home', 'gone'].includes(item.status)) continue;
      const ev = db.transaction((tx) => {
        const e = recordEventTx(tx, 'item.status', 'item', id, {
          prev: { status: item.status, lent_to: item.lentTo, out_since: item.outSince, hidden_at: item.hiddenAt },
          next: { status: 'home' },
        });
        tx.update(items)
          .set({ status: 'home', lentTo: null, outSince: null })
          .where(eq(items.id, id))
          .run();
        return e;
      });
      eventIds.push(ev.id);
    }
    return { ok: true, put_back: eventIds.length, event_ids: eventIds };
  });

  // --- Webhooks (token-authed, for Home Assistant and friends) --------------

  // HA sensor: out count + names. GET /api/webhooks/out-sensor?token=...
  app.get('/api/webhooks/out-sensor', async (req, reply) => {
    if (!(await verifyWebhookToken(requestToken(req))))
      return reply.code(401).send({ error: 'bad token' });
    const { out, unaccounted } = await fetchMissing(null);
    const list = [...out, ...unaccounted];
    const thumbs = await outJson(list);
    const low = await fetchLowStock(null);
    const warranties = await fetchWarrantyExpiring(null);
    return {
      out_count: out.length,
      unaccounted_count: unaccounted.length,
      total: list.length,
      items: thumbs.map((i) => ({ name: i.name, path: i.area_path, days: i.days })),
      low_stock_count: low.length,
      low_stock: low.map((i) => ({ name: i.name, quantity: i.quantity, restock_below: i.restockBelow })),
      warranty_expiring: warranties.map((i) => ({ name: i.name, warranty_until: i.warrantyUntil })),
    };
  });

  // HA automation trigger: POST /api/webhooks/digest?token=...
  app.post('/api/webhooks/digest', async (req, reply) => {
    if (!(await verifyWebhookToken(requestToken(req))))
      return reply.code(401).send({ error: 'bad token' });
    return sendDigest();
  });

  // Manual "send now" from Settings.
  app.post('/api/digest/test', async (req, reply) => {
    const cfg = await getDigestConfig();
    if (!cfg.webhook_url) return reply.badRequest('webhook_url not configured');
    try {
      return await sendDigest();
    } catch (e) {
      return reply.badRequest(`webhook failed: ${(e as Error).message}`);
    }
  });
}

export { webhookToken };
