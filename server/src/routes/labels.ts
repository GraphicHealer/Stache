import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, query, queryOne } from '../db';
import { areas, labels } from '../db/schema';
import { newLabelCode } from '../lib/labelcode';
import { recordEventTx } from '../lib/events';
import { parseBody } from '../lib/validate';

const DeleteLabelsSchema = z.object({
  codes: z.array(z.string().max(20)).min(1).max(500),
});

export async function labelRoutes(app: FastifyInstance) {
  // All labels, with what each is attached to (for the print sheet + status).
  app.get('/api/labels', async () => {
    const rows = await db
      .select({
        code: labels.code,
        batch: labels.batch,
        area_id: labels.areaId,
        area_name: areas.name,
        area_tags: areas.tags,
        created_at: labels.createdAt,
      })
      .from(labels)
      .leftJoin(areas, eq(labels.areaId, areas.id))
      .orderBy(asc(labels.code));

    // Breadcrumb path for claimed labels - built in JS from one area fetch.
    const allAreas = await db
      .select({ id: areas.id, parentId: areas.parentId, name: areas.name })
      .from(areas);
    const byId = new Map(allAreas.map((a) => [a.id, a]));
    const pathFor = (id: string | null) => {
      const parts: string[] = [];
      for (let cur = id; cur && byId.has(cur) && parts.length < 32; ) {
        const a = byId.get(cur)!;
        parts.unshift(a.name ?? 'unnamed');
        cur = a.parentId;
      }
      return parts.length ? parts.join(' / ') : null;
    };
    return {
      labels: rows.map((r) => ({ ...r, area_path: pathFor(r.area_id) })),
    };
  });

  // Pre-print a batch of labels - random codes, unclaimed until first scan.
  app.post('/api/labels/batch', async (req, reply) => {
    const body = (req.body ?? {}) as { count?: number };
    const count = Math.min(500, Math.max(1, Math.floor(Number(body.count)) || 24));

    const batchRow = queryOne<{ batch: number }>(
      `SELECT coalesce(max(batch), 0) + 1 AS batch FROM labels`,
    )!;
    const taken = new Set(query<{ code: string }>(`SELECT code FROM labels`).map((r) => r.code));

    const codes: { code: string; batch: number }[] = [];
    while (codes.length < count) {
      const code = newLabelCode();
      if (taken.has(code)) continue;
      taken.add(code);
      codes.push({ code, batch: batchRow.batch });
    }
    await db.insert(labels).values(codes);
    return reply.code(201).send({ batch: batchRow.batch, labels: codes.map((c) => c.code) });
  });

  // Delete unclaimed codes (e.g. misprints). Claimed labels are attached to
  // areas and can't be deleted here - archive the area instead.
  app.post('/api/labels/delete', async (req, reply) => {
    const body = parseBody(DeleteLabelsSchema, req.body, reply);
    if (!body) return;
    const codes = body.codes.map((c) => c.toUpperCase());
    const r = await db
      .delete(labels)
      .where(and(inArray(labels.code, codes), isNull(labels.areaId)));
    return { deleted: r.changes, skipped: codes.length - r.changes };
  });

  // Attach a code to an existing bin (claim or reassign between bins).
  app.post('/api/labels/:code/assign', async (req, reply) => {
    const { code: raw } = req.params as { code: string };
    const code = raw.toUpperCase();
    const body = (req.body ?? {}) as { area_id?: string };
    if (!body.area_id) return reply.badRequest('area_id required');
    const [label] = await db.select().from(labels).where(eq(labels.code, code));
    if (!label) return reply.notFound('unknown label');
    const [area] = await db.select().from(areas).where(eq(areas.id, body.area_id));
    if (!area || area.archivedAt) return reply.badRequest('area not found');
    const prevAreaId = label.areaId;
    db.transaction((tx) => {
      tx.update(labels).set({ areaId: area.id }).where(eq(labels.code, code)).run();
      if (!area.labelCode) tx.update(areas).set({ labelCode: code }).where(eq(areas.id, area.id)).run();
      recordEventTx(tx, 'label.assigned', 'label', code, { area_id: area.id, prev_area_id: prevAreaId }, req.user?.id);
    });
    return { ok: true, area: { id: area.id, name: area.name } };
  });

  // Detach a code from its bin - back to unclaimed.
  app.post('/api/labels/:code/unassign', async (req, reply) => {
    const { code: raw } = req.params as { code: string };
    const code = raw.toUpperCase();
    const [label] = await db.select().from(labels).where(eq(labels.code, code));
    if (!label) return reply.notFound('unknown label');
    db.transaction((tx) => {
      tx.update(labels).set({ areaId: null }).where(eq(labels.code, code)).run();
      tx.update(areas).set({ labelCode: null }).where(eq(areas.labelCode, code)).run();
      recordEventTx(tx, 'label.unassigned', 'label', code, { prev_area_id: label.areaId }, req.user?.id);
    });
    return { ok: true };
  });

  // What a scanned label resolves to.
  app.get('/api/labels/:code', async (req, reply) => {
    const { code: raw } = req.params as { code: string };
    const code = raw.toUpperCase();
    const [label] = await db.select().from(labels).where(eq(labels.code, code));
    if (!label) return reply.notFound('unknown label');
    if (!label.areaId) return { status: 'unclaimed', code: label.code };
    const [area] = await db.select().from(areas).where(eq(areas.id, label.areaId));
    return {
      status: 'area',
      code: label.code,
      area: area
        ? { id: area.id, name: area.name, archived: !!area.archivedAt }
        : null,
    };
  });
}
