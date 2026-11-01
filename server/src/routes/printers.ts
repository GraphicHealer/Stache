import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { labels, printers, settings } from '../db/schema';
import { printLabels } from '../lib/print';
import { requireAdmin } from '../lib/guards';
import { getDigestConfig } from '../lib/digest';
import { parseBody } from '../lib/validate';
import { LABEL_CODE_RE } from '../lib/labelcode';
import { DEFAULT_SHEET, SHEET_PRESETS, resolveSheet, type SheetChoice } from '../lib/sheetspec';
import { z } from 'zod';

const SheetChoiceSchema = z
  .object({
    preset: z.string().max(50).optional(),
    custom: z
      .object({
        page: z.enum(['letter', 'a4']).optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
        cellW: z.number().optional(),
        cellH: z.number().optional(),
        gapX: z.number().optional(),
        gapY: z.number().optional(),
        marginTop: z.number().optional(),
        marginX: z.number().optional(),
      })
      .optional(),
  })
  .nullish();

const PrinterCreateSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['zpl', 'cups', 'dymo']),
  host: z.string().max(255).nullish(),
  port: z.union([z.number().int().min(1).max(65535), z.string()]).optional(),
  queue: z.string().max(255).nullish(),
  dpi: z.union([z.number(), z.string()]).optional(),
  label_w_mm: z.union([z.number(), z.string()]).optional(),
  label_h_mm: z.union([z.number(), z.string()]).optional(),
  media_type: z.enum(['label', 'sheet']).optional(),
  sheet: SheetChoiceSchema,
}).passthrough();

const PrinterPatchSchema = PrinterCreateSchema.partial();

const PrintLabelsSchema = z.object({
  printer_id: z.string(),
  codes: z.array(z.string().regex(LABEL_CODE_RE, 'invalid label code')).min(1).max(200),
}).passthrough();

// Codes become filenames and are interpolated into ZPL/SVG - strict shape only.
const CODE_RE = LABEL_CODE_RE;

// Label QRs need an absolute origin. A configured public base URL wins -
// printing from a localhost session otherwise makes dead labels.
function originOf(req: FastifyRequest, configured?: string): string {
  const conf = configured?.replace(/\/$/, '');
  if (conf) return conf;
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

async function publicBaseUrl(): Promise<string | undefined> {
  const cfg = await getDigestConfig();
  return cfg.base_url || undefined;
}

const FIELDS = ['name', 'type', 'host', 'port', 'queue', 'dpi', 'label_w_mm', 'label_h_mm', 'media_type', 'sheet'] as const;

const PC_ID = 'pc';

/** The built-in "Print from this PC" entry - config lives in settings. */
async function pcPrinter() {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'pc_printer'));
  const cfg = (row?.value ?? {}) as Record<string, unknown>;
  return {
    id: PC_ID,
    name: 'Print from this PC',
    type: 'pc',
    builtin: true,
    host: null,
    port: 0,
    queue: null,
    dpi: Number(cfg.dpi) || 300,
    label_w_mm: Number(cfg.label_w_mm) || 57,
    label_h_mm: Number(cfg.label_h_mm) || 32,
    media_type: (cfg.media_type as string) ?? 'sheet',
    sheet: (cfg.sheet as SheetChoice) ?? DEFAULT_SHEET,
    created_at: null,
  };
}

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
    mediaType: body.media_type === 'sheet' ? 'sheet' : 'label',
    sheet: (body.sheet as SheetChoice) ?? null,
  };
}

export async function printerRoutes(app: FastifyInstance) {
  const defaultPrinterId = async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'default_printer'));
    return (row?.value as { id?: string } | null)?.id ?? PC_ID;
  };

  app.post('/api/printers/default', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(z.object({ id: z.string() }), req.body, reply);
    if (!body) return;
    if (body.id !== PC_ID) {
      const [p] = await db.select().from(printers).where(eq(printers.id, body.id));
      if (!p) return reply.notFound('printer not found');
    }
    await db
      .insert(settings)
      .values({ key: 'default_printer', value: { id: body.id } as any })
      .onConflictDoUpdate({ target: settings.key, set: { value: { id: body.id } as any } });
    return { ok: true, id: body.id };
  });

  app.get('/api/printers', async () => ({
    printers: [
      await pcPrinter(),
      ...(await db.select().from(printers).orderBy(asc(printers.createdAt))),
    ],
  }));

  // Sheet template presets - shared by the PC printer, CUPS sheets, the UI.
  app.get('/api/sheet-templates', async () => ({ templates: SHEET_PRESETS }));

  // The built-in PC printer is configured, not created/deleted.
  app.patch('/api/printers/pc', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(
      z.object({
        media_type: z.enum(['label', 'sheet']).optional(),
        sheet: SheetChoiceSchema,
        label_w_mm: z.union([z.number(), z.string()]).optional(),
        label_h_mm: z.union([z.number(), z.string()]).optional(),
        dpi: z.union([z.number(), z.string()]).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const cfg = {
      media_type: body.media_type ?? 'sheet',
      sheet: body.sheet ?? DEFAULT_SHEET,
      label_w_mm: body.label_w_mm ? Number(body.label_w_mm) : 57,
      label_h_mm: body.label_h_mm ? Number(body.label_h_mm) : 32,
      dpi: body.dpi ? Number(body.dpi) : 300,
    };
    if (cfg.media_type === 'sheet' && !resolveSheet(cfg.sheet))
      return reply.badRequest('invalid sheet spec');
    await db
      .insert(settings)
      .values({ key: 'pc_printer', value: cfg as any })
      .onConflictDoUpdate({ target: settings.key, set: { value: cfg as any } });
    return { printer: await pcPrinter() };
  });

  app.delete('/api/printers/pc', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.badRequest('the PC printer is built in'),
  );

  // Adding/editing printers = raw TCP/CUPS targets - admin only.
  app.post('/api/printers', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = parseBody(PrinterCreateSchema, req.body, reply);
    if (!parsed) return;
    const body = printerBody(parsed);
    const [p] = await db.insert(printers).values(body).returning();
    return reply.code(201).send({ printer: p });
  });

  app.patch('/api/printers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(printers).where(eq(printers.id, id));
    if (!p) return reply.notFound();
    const body = parseBody(PrinterPatchSchema, req.body, reply) as Record<string, any> | null;
    if (!body) return;
    const updates: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        const key =
          { label_w_mm: 'labelWmm', label_h_mm: 'labelHmm', media_type: 'mediaType' }[
            f as string
          ] ?? f;
        updates[key] = body[f] === '' ? null : body[f];
      }
    }
    if ((updates.name !== undefined && !updates.name) || (updates.type !== undefined && !updates.type))
      return reply.badRequest('name and type cannot be empty');
    const [updated] = await db.update(printers).set(updates).where(eq(printers.id, id)).returning();
    return { printer: updated };
  });

  app.delete('/api/printers/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(printers).where(eq(printers.id, id));
    return { ok: true };
  });

  // Test label - Zebra gets real ZPL; CUPS gets a PNG.
  app.post('/api/printers/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(printers).where(eq(printers.id, id));
    if (!p) return reply.notFound();
    try {
      await printLabels(p, ['ST-23456789'], originOf(req, await publicBaseUrl()));
      return { ok: true };
    } catch (e) {
      return reply.badRequest(`print failed: ${(e as Error).message}`);
    }
  });

  // Print specific label codes to a printer.
  app.post('/api/labels/print', async (req, reply) => {
    const body = parseBody(PrintLabelsSchema, req.body, reply);
    if (!body) return;
    if (body.printer_id === PC_ID)
      return reply.badRequest('the PC printer prints from the browser');
    const [p] = await db.select().from(printers).where(eq(printers.id, body.printer_id));
    if (!p) return reply.notFound('printer not found');
    if (p.type === 'dymo')
      return reply.badRequest('dymo printers print from the browser (DYMO Web Service)');
    const codes = body.codes.slice(0, 200).map((c) => c.toUpperCase());
    if (!codes.every((c) => typeof c === 'string' && CODE_RE.test(c)))
      return reply.badRequest('invalid label code');
    const existing = new Set(
      (await db.select({ code: labels.code }).from(labels).where(inArray(labels.code, codes))).map(
        (r) => r.code,
      ),
    );
    try {
      const valid = codes.filter((c) => existing.has(c));
      await printLabels(p, valid, originOf(req, await publicBaseUrl()));
      if (valid.length)
        await db.update(labels).set({ printedAt: new Date() }).where(inArray(labels.code, valid));
      return { ok: true, printed: valid.length };
    } catch (e) {
      return reply.badRequest(`print failed: ${(e as Error).message}`);
    }
  });
}
