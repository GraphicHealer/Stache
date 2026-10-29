import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, query, queryOne } from '../db';
import { areas, labels } from '../db/schema';
import { newLabelCode } from '../lib/labelcode';

export async function labelRoutes(app: FastifyInstance) {
  // All labels, with what each is attached to (for the print sheet + status).
  app.get('/api/labels', async () => {
    const rows = await db
      .select({
        code: labels.code,
        batch: labels.batch,
        area_id: labels.areaId,
        area_name: areas.name,
        created_at: labels.createdAt,
      })
      .from(labels)
      .leftJoin(areas, eq(labels.areaId, areas.id))
      .orderBy(asc(labels.code));
    return { labels: rows };
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
