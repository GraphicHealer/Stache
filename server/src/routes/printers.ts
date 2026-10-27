import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { printers } from '../db/schema';
import { printLabels } from '../lib/print';

function originOf(req: FastifyRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

const FIELDS = ['name', 'type', 'host', 'port', 'queue', 'dpi', 'label_w_mm', 'label_h_mm'] as const;

function printerBody(body: Record<string, any>) {
  return {
    name: body.name,
    type: body.type,
    host: body.host ?? null,
    port: body.port ? Number(body.port) : 9100,
    queue: body.queue ?? null,
    dpi: body.dpi ? Number(body.dpi) : 203,
    labelWmm: body.label_w_mm ? Number(body.label_w_mm) : 57,
    labelHmm: body.label_h_mm ? Number(body.label_h_mm) : 32,
  };
}

export async function printerRoutes(app: FastifyInstance) {
  app.get('/api/printers', async () => ({
    printers: await db.select().from(printers).orderBy(asc(printers.createdAt)),
  }));

  app.post('/api/printers', async (req, reply) => {
    const body = printerBody((req.body ?? {}) as Record<string, any>);
    if (!body.name || !['zpl', 'cups', 'dymo'].includes(body.type))
      return reply.badRequest('name and type (zpl|cups|dymo) are required');
    const [p] = await db.insert(printers).values(body).returning();
    return reply.code(201).send({ printer: p });
  });

  app.patch('/api/printers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(printers).where(eq(printers.id, id));
    if (!p) return reply.notFound();
    const body = (req.body ?? {}) as Record<string, any>;
    const updates: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        const key = { label_w_mm: 'labelWmm', label_h_mm: 'labelHmm' }[f as string] ?? f;
        updates[key] = body[f] === '' || body[f] === null ? null : body[f];
      }
    }
    const [updated] = await db.update(printers).set(updates).where(eq(printers.id, id)).returning();
    return { printer: updated };
  });

  app.delete('/api/printers/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(printers).where(eq(printers.id, id));
    return { ok: true };
  });

  // Test label — Zebra gets real ZPL; CUPS gets a PNG.
  app.post('/api/printers/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(printers).where(eq(printers.id, id));
    if (!p) return reply.notFound();
    try {
      await printLabels(p, ['ST-000000'], originOf(req));
      return { ok: true };
    } catch (e) {
      return reply.badRequest(`print failed: ${(e as Error).message}`);
    }
  });

  // Print specific label codes to a printer.
  app.post('/api/labels/print', async (req, reply) => {
    const body = (req.body ?? {}) as { printer_id?: string; codes?: string[] };
    if (!body.printer_id || !body.codes?.length)
      return reply.badRequest('printer_id and codes[] are required');
    const [p] = await db.select().from(printers).where(eq(printers.id, body.printer_id));
    if (!p) return reply.notFound('printer not found');
    if (p.type === 'dymo')
      return reply.badRequest('dymo printers print from the browser (DYMO Web Service)');
    try {
      await printLabels(p, body.codes.slice(0, 200), originOf(req));
      return { ok: true, printed: Math.min(body.codes.length, 200) };
    } catch (e) {
      return reply.badRequest(`print failed: ${(e as Error).message}`);
    }
  });
}
