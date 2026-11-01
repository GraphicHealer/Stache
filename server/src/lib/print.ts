import net from 'node:net';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import QRCode from 'qrcode';
import sharp from 'sharp';
import type { Printer } from '../db/schema';
import { db } from '../db';
import { areas, labels } from '../db/schema';
import { PAGE_SIZES, resolveSheet, type SheetSpec } from './sheetspec';

const MM_PER_DOT = (dpi: number) => 25.4 / dpi;

function sendTcp(host: string, port: number, payload: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(8000);
    sock.once('connect', () => {
      sock.write(payload, () => sock.end());
    });
    sock.once('timeout', () => {
      sock.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    });
    sock.once('error', reject);
    sock.once('close', () => resolve());
  });
}

/** ZPL for one label: QR code + human-readable code beneath it. */
export function zplForLabel(code: string, url: string, p: Printer): string {
  const w = Math.round(p.labelWmm / MM_PER_DOT(p.dpi));
  const h = Math.round(p.labelHmm / MM_PER_DOT(p.dpi));
  const qrDots = Math.min(w, h) * 0.72;
  // ^BQ magnification ~ module size in dots; QR v3-ish ≈ 33 modules incl. quiet zone.
  const mag = Math.max(1, Math.min(10, Math.floor(qrDots / 33)));
  const qrSide = 33 * mag;
  const textH = Math.round(3.5 / MM_PER_DOT(p.dpi));
  const qrX = Math.round((w - qrSide) / 2);
  const qrY = Math.round((h - qrSide - textH) / 2);
  return [
    '^XA',
    `^PW${w}`,
    `^LL${h}`,
    `^FO${qrX},${qrY}^BQN,2,${mag}^FDQA,${url}^FS`,
    `^FO0,${qrY + qrSide + Math.round(1 / MM_PER_DOT(p.dpi))}^A0N,${textH},${textH}^FB${w},1,0,C,0^FD${code}^FS`,
    '^XZ',
  ].join('\n');
}

export async function printZpl(p: Printer, codes: string[], origin: string): Promise<void> {
  if (!p.host) throw new Error('printer host not set');
  const zpl = codes
    .map((code) => zplForLabel(code, `${origin}/l/${code}`, p))
    .join('\n');
  await sendTcp(p.host, p.port, zpl);
}

/** QR code rendered to a PNG sized for the label, for CUPS queues. */
export async function labelPng(code: string, url: string, p: Printer): Promise<Buffer> {
  const w = Math.round(p.labelWmm / MM_PER_DOT(p.dpi));
  const h = Math.round(p.labelHmm / MM_PER_DOT(p.dpi));
  const qr = await QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 1 });
  const qrSide = Math.round(Math.min(w, h) * 0.72);
  const qrImg = await sharp(qr).resize(qrSide, qrSide, { kernel: 'nearest' }).png().toBuffer();
  const textH = Math.round(4 / MM_PER_DOT(p.dpi));
  const text = Buffer.from(
    `<svg width="${w}" height="${textH}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="80%" font-family="monospace" font-size="${Math.round(textH * 0.7)}"
        font-weight="bold" text-anchor="middle">${code}</text>
    </svg>`,
  );
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: qrImg, left: Math.round((w - qrSide) / 2), top: Math.round((h - qrSide - textH) / 2) },
      { input: text, left: 0, top: h - textH },
    ])
    .png()
    .toBuffer();
}

function lp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('lp', args, (err, _stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(),
    );
  });
}

/** Print via CUPS - needs `lp` in the image (cups-client) and a reachable server. */
export async function printCups(p: Printer, codes: string[], origin: string): Promise<void> {
  if (!p.queue) throw new Error('CUPS queue name not set');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stache-labels-'));
  try {
    for (const code of codes) {
      const file = path.join(dir, `${code}.png`);
      await fs.writeFile(file, await labelPng(code, `${origin}/l/${code}`, p));
      const args = ['-d', p.queue];
      if (p.host) args.push('-h', p.host);
      args.push('-o', 'fit-to-page', file);
      await lp(args);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface CellInfo {
  code: string;
  name: string | null;
  path: string | null;
  tags: string[];
}

/** code -> bin details for sheet cells (same lookup the labels API uses). */
async function cellInfos(codes: string[]): Promise<Map<string, CellInfo>> {
  const rows = await db
    .select({ code: labels.code, areaId: labels.areaId, name: areas.name, tags: areas.tags })
    .from(labels)
    .leftJoin(areas, eq(labels.areaId, areas.id))
    .where(inArray(labels.code, codes));
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
    return parts.join(' / ');
  };
  const out = new Map<string, CellInfo>();
  for (const c of codes) {
    const r = rows.find((x) => x.code === c);
    const path = r?.areaId ? pathFor(r.areaId) : '';
    const name = r?.name ?? null;
    const parent = name && path.endsWith(` / ${name}`) ? path.slice(0, -` / ${name}`.length) : null;
    out.set(c, { code: c, name, path: parent || null, tags: (r?.tags as string[] | null) ?? [] });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One cell as an SVG tile: QR + code column, text, logo bottom-right. */
async function cellSvg(
  info: CellInfo,
  origin: string,
  spec: SheetSpec,
  px: (mm: number) => number,
): Promise<Buffer> {
  const cw = px(spec.cellW);
  const ch = px(spec.cellH);
  const qrSide = Math.min(ch - px(4), px(spec.cellW) * 0.4);
  const qr = await QRCode.toBuffer(`${origin}/l/${info.code}`, { errorCorrectionLevel: 'M', margin: 0 });
  const qrB64 = `data:image/png;base64,${qr.toString('base64')}`;
  const textX = qrSide + px(1.5);
  const font = (mm: number) => Math.max(6, Math.round(px(mm)));
  const clip = (s: string, mmFont: number) => {
    const max = Math.floor((spec.cellW - spec.cellH - 16) / (mmFont * 0.62));
    return esc(s.length > max && max > 3 ? `${s.slice(0, max - 1)}…` : s);
  };
  let text = '';
  if (info.name) {
    let y = px(5);
    if (info.path) {
      text += `<text x="${textX}" y="${y}" font-family="sans-serif" font-size="${font(2.3)}" fill="#333">${clip(info.path, 2.3)}</text>`;
      y += px(4);
    }
    text += `<text x="${textX}" y="${y + px(2)}" font-family="sans-serif" font-size="${font(3.4)}" font-weight="bold">${clip(info.name, 3.4)}</text>`;
    if (info.tags.length)
      text += `<text x="${textX}" y="${y + px(5)}" font-family="sans-serif" font-size="${font(2.3)}" fill="#333">${clip(info.tags.join(', '), 2.3)}</text>`;
  } else {
    const lines = [0.36, 0.62, 0.88].map((f) => Math.round(ch * f));
    text = lines
      .map(
        (y) =>
          `<line x1="${textX}" y1="${y}" x2="${cw - px(8)}" y2="${y}" stroke="#000" stroke-width="${Math.max(1, px(0.4))}" />`,
      )
      .join('');
  }
  const logoSide = px(12);
  let logo = '';
  try {
    const logoBuf = await fs.readFile(path.join(process.cwd(), 'client', 'dist', 'logo-mono.svg'));
    logo = `<image href="data:image/svg+xml;base64,${logoBuf.toString('base64')}" x="${cw - logoSide - px(0.8)}" y="${ch - logoSide - px(0.5)}" width="${logoSide}" height="${logoSide}"/>`;
  } catch {
    // logo asset missing - cells still print fine without it
  }
  return Buffer.from(
    `<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg">
      <image href="${qrB64}" x="0" y="${Math.round((ch - qrSide) / 2) - px(2)}" width="${qrSide}" height="${qrSide}"/>
      <text x="${Math.round(qrSide / 2)}" y="${Math.round((ch + qrSide) / 2) + px(1)}" font-family="monospace" font-size="${font(2.1)}" fill="#444" text-anchor="middle">${esc(info.code)}</text>
      ${text}${logo}
    </svg>`,
  );
}

/**
 * CUPS 'sheet' media: render whole Letter/A4 pages at 300dpi and lp them.
 * Cells mirror the browser print layout - QR + code, name/path/tags, logo.
 */
export async function printCupsSheet(p: Printer, codes: string[], origin: string): Promise<void> {
  if (!p.queue) throw new Error('CUPS queue name not set');
  const spec =
    resolveSheet(p.sheet as Parameters<typeof resolveSheet>[0]) ??
    resolveSheet({ preset: 'avery-5160' })!;
  const dpi = 300;
  const px = (mm: number) => Math.round((mm / 25.4) * dpi);
  const page = PAGE_SIZES[spec.page];
  const pw = px(page.w);
  const ph = px(page.h);
  const perPage = spec.cols * spec.rows;
  const infos = await cellInfos(codes);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stache-sheet-'));
  try {
    for (let pg = 0; pg * perPage < codes.length; pg++) {
      const chunk = codes.slice(pg * perPage, (pg + 1) * perPage);
      const tiles = await Promise.all(
        chunk.map(async (c, i) => ({
          input: await cellSvg(infos.get(c)!, origin, spec, px),
          left: px(spec.marginX) + (i % spec.cols) * px(spec.cellW + spec.gapX),
          top: px(spec.marginTop) + Math.floor(i / spec.cols) * px(spec.cellH + spec.gapY),
        })),
      );
      const file = path.join(dir, `sheet-${pg}.png`);
      await sharp({
        create: { width: pw, height: ph, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite(tiles)
        .png()
        .toFile(file);
      const args = ['-d', p.queue];
      if (p.host) args.push('-h', p.host);
      args.push('-o', 'fit-to-page', file);
      await lp(args);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Server-side print dispatch. 'dymo'/'pc' are client-side. */
export async function printLabels(
  p: Printer,
  codes: string[],
  origin: string,
): Promise<void> {
  if (p.type === 'zpl') return printZpl(p, codes, origin);
  if (p.type === 'cups')
    return p.mediaType === 'sheet' ? printCupsSheet(p, codes, origin) : printCups(p, codes, origin);
  throw new Error(`printer type ${p.type} is printed from the browser`);
}
