import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { env } from '../env';
import { areas, events, items, user } from '../db/schema';
import { undoEvent } from '../lib/events';
import { itemVisible } from '../lib/visibility';
import { requireAdmin } from '../lib/guards';
import { thumbsForItems, thumbUrl } from '../lib/photos';
import { breadcrumb } from '../lib/breadcrumb';
import { fetchLowStock, fetchWarrantyExpiring } from '../lib/digest';

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
    const names = new Map(
      (await db.select({ id: user.id, name: user.name }).from(user)).map((u) => [u.id, u.name]),
    );
    return {
      events: visible.map((e) => ({
        id: e.id,
        type: e.type,
        entity_type: e.entityType,
        entity_id: e.entityId,
        payload: e.payload,
        user_id: e.userId,
        user_name: e.userId ? (names.get(e.userId) ?? 'someone') : null,
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

  // Trash: hidden items + archived areas, restorable or purgeable.
  app.get('/api/trash', async (req) => {
    const uid = req.user?.id ?? null;
    const hidden = await db
      .select()
      .from(items)
      .where(and(isNotNull(items.hiddenAt), itemVisible(uid)))
      .orderBy(desc(items.hiddenAt));
    const archived = await db
      .select()
      .from(areas)
      .where(isNotNull(areas.archivedAt))
      .orderBy(desc(areas.archivedAt));
    const thumbs = await thumbsForItems(hidden.map((i) => i.id));
    return {
      items: hidden.map((i) => {
        const t = thumbs.get(i.id);
        return {
          id: i.id,
          name: i.name,
          thumb: t ? thumbUrl(t) : null,
          hidden_at: i.hiddenAt,
        };
      }),
      areas: archived.map((a) => ({ id: a.id, name: a.name, archived_at: a.archivedAt })),
    };
  });

  // Full inventory export - what you can see, as JSON or CSV.
  app.get('/api/export', async (req, reply) => {
    const { format } = req.query as { format?: string };
    const uid = req.user?.id ?? null;
    const vis = itemVisible(uid);
    const allItems = await db.select().from(items).where(vis).orderBy(asc(items.createdAt));
    const allAreas = await db.select().from(areas).orderBy(asc(areas.createdAt));
    const pathCache = new Map<string, string>();
    const areaPath = async (id: string) => {
      if (!pathCache.has(id)) {
        const c = await breadcrumb(id);
        pathCache.set(id, c.map((x) => x.name ?? '?').join(' › '));
      }
      return pathCache.get(id)!;
    };

    if (format === 'csv') {
      const cols = [
        'id', 'name', 'description', 'quantity', 'barcode', 'status', 'lent_to',
        'area_path', 'area_id', 'out_since', 'warranty_until', 'restock_below',
        'is_private', 'hidden', 'created_at',
      ];
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [cols.join(',')];
      for (const i of allItems) {
        lines.push([
          i.id, i.name, i.description, i.quantity, i.barcode, i.status, i.lentTo,
          await areaPath(i.areaId), i.areaId,
          i.outSince?.toISOString(), i.warrantyUntil, i.restockBelow,
          i.isPrivate ? 1 : 0, i.hiddenAt ? 1 : 0, i.createdAt.toISOString(),
        ].map(esc).join(','));
      }
      reply
        .header('content-type', 'text/csv')
        .header('content-disposition', 'attachment; filename="stache-items.csv"');
      return reply.send(lines.join('\n'));
    }

    return {
      exported_at: new Date().toISOString(),
      areas: await Promise.all(
        allAreas.map(async (a) => ({
          id: a.id,
          name: a.name,
          parent_id: a.parentId,
          label_code: a.labelCode,
          path: await areaPath(a.id),
          archived: !!a.archivedAt,
        })),
      ),
      items: allItems.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        barcode: i.barcode,
        status: i.status,
        lent_to: i.lentTo,
        area_id: i.areaId,
        out_since: i.outSince,
        warranty_until: i.warrantyUntil,
        restock_below: i.restockBelow,
        is_private: i.isPrivate,
        hidden: !!i.hiddenAt,
        ai_name: i.aiName,
        ai_tags: i.aiTags,
        ocr_text: i.ocrText,
        created_at: i.createdAt,
      })),
    };
  });

  // Consistent snapshot of the live database (SQLite backup API under the
  // hood - safe on a WAL database, unlike copying the files). Keeps 10.
  app.post('/api/backup', { preHandler: requireAdmin }, async () => {
    const dir = path.join(env.dataDir, 'backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `stache-${stamp}.db`);
    await sqlite.backup(file);
    const stat = await fs.stat(file);

    const backups = (await fs.readdir(dir)).filter((f) => f.endsWith('.db')).sort();
    for (const f of backups.slice(0, Math.max(0, backups.length - 10))) {
      await fs.rm(path.join(dir, f), { force: true });
    }
    return { ok: true, file: path.basename(file), bytes: stat.size };
  });
}
