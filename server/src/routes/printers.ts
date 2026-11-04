import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { labels, printers, settings } from '../db/schema';
import { printLabels, labelZpl } from '../lib/print';
import { requireAdmin } from '../lib/guards';
import { getDigestConfig } from '../lib/digest';
import { parseBody } from '../lib/validate';
import { LABEL_CODE_RE } from '../lib/labelcode';
import { DEFAULT_SHEET, SHEET_PRESETS, resolveSheet, type SheetChoice } from '../lib/sheetspec';
import { z } from 'zod';
import net from 'node:net';

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
  type: z.enum(['zpl', 'zpl-legacy', 'cups', 'dymo']),
  host: z.string().max(255).nullish(),
  port: z.union([z.number().int().min(1).max(65535), z.string()]).optional(),
  queue: z.string().max(255).nullish(),
  dpi: z.union([z.number(), z.string()]).optional(),
  label_w_mm: z.union([z.number(), z.string()]).optional(),
  label_h_mm: z.union([z.number(), z.string()]).optional(),
  top_offset_mm: z.union([z.number(), z.string()]).optional(),
  left_offset_mm: z.union([z.number(), z.string()]).optional(),
  right_offset_mm: z.union([z.number(), z.string()]).optional(),
  bottom_offset_mm: z.union([z.number(), z.string()]).optional(),
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

const FIELDS = ['name', 'type', 'host', 'port', 'queue', 'dpi', 'label_w_mm', 'label_h_mm', 'top_offset_mm', 'left_offset_mm', 'right_offset_mm', 'bottom_offset_mm', 'media_type', 'sheet'] as const;

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

const num = (v: unknown) => (v != null && v !== '' ? Number(v) : 0);

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
    topOffsetMm: body.top_offset_mm != null && body.top_offset_mm !== '' ? Number(body.top_offset_mm) : 1,
    leftOffsetMm: body.left_offset_mm != null && body.left_offset_mm !== '' ? num(body.left_offset_mm) : 1,
    rightOffsetMm: body.right_offset_mm != null && body.right_offset_mm !== '' ? num(body.right_offset_mm) : 1,
    bottomOffsetMm: body.bottom_offset_mm != null && body.bottom_offset_mm !== '' ? num(body.bottom_offset_mm) : 1,
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

  const rowJson = (r: typeof printers.$inferSelect) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    builtin: false,
    host: r.host,
    port: r.port,
    queue: r.queue,
    dpi: r.dpi,
    label_w_mm: r.labelWmm,
    label_h_mm: r.labelHmm,
    top_offset_mm: r.topOffsetMm,
    left_offset_mm: r.leftOffsetMm,
    right_offset_mm: r.rightOffsetMm,
    bottom_offset_mm: r.bottomOffsetMm,
    media_type: r.mediaType,
    sheet: r.sheet,
    created_at: r.createdAt,
  });

  app.get('/api/printers', async () => ({
    default_id: await defaultPrinterId(),
    printers: [
      await pcPrinter(),
      ...(await db.select().from(printers).orderBy(asc(printers.createdAt))).map(rowJson),
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
    const numeric = new Set(['port', 'dpi', 'label_w_mm', 'label_h_mm', 'top_offset_mm', 'left_offset_mm', 'right_offset_mm', 'bottom_offset_mm']);
    const updates: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        const key =
          { label_w_mm: 'labelWmm', label_h_mm: 'labelHmm', top_offset_mm: 'topOffsetMm', left_offset_mm: 'leftOffsetMm', right_offset_mm: 'rightOffsetMm', bottom_offset_mm: 'bottomOffsetMm', media_type: 'mediaType' }[
            f as string
          ] ?? f;
        updates[key] = body[f] === '' ? null : numeric.has(f) ? num(body[f]) : body[f];
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

  // Ask a Zebra what it has loaded, over the same TCP port ZPL prints to.
  // Individual SGD getvars (works on old firmware - allcv doesn't exist
  // everywhere); values come back positionally. ~JC first runs the printer's
  // own media calibration - it feeds a label to measure the gap.
  const probeZebra = async (host: string, port: number, calibrate: boolean) => {
    const names = ['head.resolution', 'zpl.label_length', 'print.width', 'media.type'];
    const cmds = names.map((n) => `! U1 getvar "${n}"`).join('\r\n') + '\r\n';
    const lines = await new Promise<string[]>((resolve, reject) => {
      const sock = net.createConnection({ host, port, timeout: 5000 });
      let buf = '';
      const done = (e?: Error) => {
        sock.destroy();
        if (e) reject(e);
        else resolve(buf.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean));
      };
      sock.on('timeout', () => done(new Error('printer timed out')));
      sock.on('error', done);
      sock.on('connect', () => sock.write((calibrate ? '~JC\r\n' : '') + cmds));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.length > 64_000) done();
      });
      setTimeout(() => done(), 4000);
    });
    const v: Record<string, string> = {};
    names.forEach((n, i) => {
      if (lines[i] && !/^(error|ERROR)/.test(lines[i])) v[n] = lines[i];
    });
    const dpmm = parseFloat(v['head.resolution'] ?? '') || 8;
    const lenDots = parseFloat(v['zpl.label_length'] ?? '') || 0;
    const widthDots = parseFloat(v['print.width'] ?? '') || 0;
    return {
      dpi: Math.round(dpmm * 25.4),
      label_h_mm: lenDots ? Math.round((lenDots / dpmm) * 10) / 10 : null,
      label_w_mm: widthDots ? Math.round((widthDots / dpmm) * 10) / 10 : null,
      media_type: v['media.type'] ?? null,
      raw: v,
    };
  };

  // Legacy Zebras (GX420d etc.) don't do SGD getvar - the ^HH host
  // verification dump carries PRINT WIDTH / LABEL LENGTH / head dpmm.
  const probeZebraLegacy = async (host: string, port: number, calibrate: boolean) => {
    const text = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ host, port, timeout: 4000 });
      let buf = '';
      const done = (e?: Error) => {
        sock.destroy();
        if (e) reject(e);
        else resolve(buf);
      };
      sock.on('timeout', () => done(new Error('printer timed out')));
      sock.on('error', done);
      sock.on('connect', () => sock.write((calibrate ? '~JC\r\n' : '') + '^XA^HH^XZ'));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.length > 64_000) done();
      });
      setTimeout(() => done(), 4000);
    });
    const num = (re: RegExp) => parseFloat(text.match(re)?.[1] ?? '') || 0;
    const dpmm = num(/(\d+)\s*\/MM/i) || 8;
    const lenDots = num(/^\s*(\d+)\s+LABEL LENGTH/im);
    const widthDots = num(/^\s*(\d+)\s+PRINT WIDTH/im);
    return {
      dpi: Math.round(dpmm * 25.4),
      label_h_mm: lenDots ? Math.round((lenDots / dpmm) * 10) / 10 : null,
      label_w_mm: widthDots ? Math.round((widthDots / dpmm) * 10) / 10 : null,
      media_type: null,
      raw: {},
    };
  };

  // Probe without a saved printer (used by the add-printer form).
  app.post('/api/printers/probe', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(
      z.object({
        host: z.string().min(1),
        port: z.number().optional(),
        calibrate: z.boolean().optional(),
        type: z.enum(['zpl', 'zpl-legacy']).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    try {
      const r =
        body.type === 'zpl-legacy'
          ? await probeZebraLegacy(body.host, body.port ?? 9100, !!body.calibrate)
          : await probeZebra(body.host, body.port ?? 9100, !!body.calibrate);
      return { ok: true, ...r };
    } catch (e) {
      return reply.badRequest(`probe failed: ${(e as Error).message}`);
    }
  });

  // Probe a saved printer and persist the detected size/dpi.
  app.post('/api/printers/:id/detect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { calibrate } = (req.body ?? {}) as { calibrate?: boolean };
    const [p] = await db.select().from(printers).where(eq(printers.id, id));
    if (!p) return reply.notFound('printer not found');
    if ((p.type !== 'zpl' && p.type !== 'zpl-legacy') || !p.host)
      return reply.badRequest('only network ZPL printers support detect');
    try {
      const r =
        p.type === 'zpl-legacy'
          ? await probeZebraLegacy(p.host, p.port || 9100, !!calibrate)
          : await probeZebra(p.host, p.port || 9100, !!calibrate);
      const set: Record<string, unknown> = {};
      if (r.label_h_mm) set.labelHmm = r.label_h_mm;
      if (r.label_w_mm) set.labelWmm = r.label_w_mm;
      if (r.dpi) set.dpi = r.dpi;
      if (Object.keys(set).length) await db.update(printers).set(set).where(eq(printers.id, id));
      return {
        ok: true,
        ...r,
        note: "width is the printer's configured print width - length is what's actually sensed",
      };
    } catch (e) {
      return reply.badRequest(`detect failed: ${(e as Error).message}`);
    }
  });

  // Print specific label codes to a printer.
  // Generated ZPL for one label on a saved Zebra - lets the client render an
  // exact preview locally (zebrash wasm) instead of approximating layout.
  app.get('/api/labels/:code/zpl', async (req, reply) => {
    const { code } = req.params as { code: string };
    const { printer_id } = req.query as { printer_id?: string };
    if (!CODE_RE.test(code)) return reply.badRequest('invalid label code');
    const [p] = await db.select().from(printers).where(eq(printers.id, printer_id ?? ''));
    if (!p || (p.type !== 'zpl' && p.type !== 'zpl-legacy'))
      return reply.notFound('zpl printer not found');
    const zpl = await labelZpl(p, code.toUpperCase(), originOf(req, await publicBaseUrl()));
    if (!zpl) return reply.notFound('unknown label code');
    return { zpl, w_mm: p.labelWmm, h_mm: p.labelHmm, dpi: p.dpi };
  });

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
