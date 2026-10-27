import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, sql } from '../db';
import { areas, labels } from '../db/schema';

const PREFIX = 'ST-';
const PAD = 6;

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

  // Pre-print a batch of sequential labels.
  app.post('/api/labels/batch', async (req, reply) => {
    const body = (req.body ?? {}) as { count?: number };
    const count = Math.min(500, Math.max(1, body.count ?? 24));

    const [{ max }] = await sql<{ max: number | null }[]>`
      SELECT max(CAST(substring(code from ${PREFIX.length + 1}) AS int)) AS max
      FROM labels WHERE code LIKE ${PREFIX + '%'}`;
    const start = (max ?? 0) + 1;
    const [batchRow] = await sql<{ batch: number }[]>`
      SELECT coalesce(max(batch), 0) + 1 AS batch FROM labels`;

    const codes = Array.from({ length: count }, (_, i) => ({
      code: `${PREFIX}${String(start + i).padStart(PAD, '0')}`,
      batch: batchRow.batch,
    }));
    await db.insert(labels).values(codes);
    return reply.code(201).send({ batch: batchRow.batch, labels: codes.map((c) => c.code) });
  });

  // What a scanned label resolves to.
  app.get('/api/labels/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
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
