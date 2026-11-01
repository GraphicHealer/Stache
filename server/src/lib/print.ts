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
  category: string | null;
}

/** code -> bin details for sheet cells (same lookup the labels API uses). */
async function cellInfos(codes: string[]): Promise<Map<string, CellInfo>> {
  const rows = await db
    .select({ code: labels.code, areaId: labels.areaId, name: areas.name, category: areas.category })
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
    out.set(c, { code: c, name, path: parent || null, category: r?.category ?? null });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One cell as an SVG tile: QR + code column, text, logo bottom-right. */
function labelMetrics(w: number, h: number) {
  const vertical = h > w * 1.4;
  const s = Math.min(3, Math.max(1, Math.min(w, h) / 25.4));
  return {
    vertical,
    qr: vertical ? Math.min(w * 0.72, h * 0.42) : Math.min(h * 0.82, w * 0.4),
    code: 2.1 * s, path: 2.3 * s, name: 3.4 * s, cat: 2.3 * s,
    logo: vertical ? Math.min(h * 0.22, w * 0.6, 48) : Math.min(10 * s, h * 0.25, w * 0.3),
  };
}

async function cellSvg(
  info: CellInfo,
  origin: string,
  spec: SheetSpec,
  px: (mm: number) => number,
): Promise<Buffer> {
  const cw = px(spec.cellW);
  const ch = px(spec.cellH);
  const qrSide = px(labelMetrics(spec.cellW, spec.cellH).qr);
  const qr = await QRCode.toBuffer(`${origin}/l/${info.code}`, { errorCorrectionLevel: 'M', margin: 0 });
  const qrB64 = `data:image/png;base64,${qr.toString('base64')}`;
  const textX = qrSide + px(1.5);
  const font = (mm: number) => Math.max(6, Math.round(px(mm)));
  const clip = (s: string, mmFont: number, widthMm: number) => {
    const max = Math.floor(widthMm / (mmFont * 0.62));
    return esc(s.length > max && max > 3 ? `${s.slice(0, max - 1)}…` : s);
  };
  const m = labelMetrics(spec.cellW, spec.cellH);
  const textW = spec.cellW - (m.vertical ? 6 : m.qr + 6);
  let text = '';
  if (info.name) {
    let y = m.vertical ? px(m.logo + 6) : px(5);
    const anchor = m.vertical ? 'middle' : undefined;
    const tx = m.vertical ? Math.round(cw / 2) : textX;
    if (info.path) {
      text += `<text x="${tx}" y="${y}" font-family="sans-serif" font-size="${font(m.path)}" fill="#333"${anchor ? ` text-anchor="${anchor}"` : ''}>${clip(info.path, m.path, textW)}</text>`;
      y += px(m.path + 1.7);
    }
    text += `<text x="${tx}" y="${y + px(2)}" font-family="sans-serif" font-size="${font(m.name)}" font-weight="bold"${anchor ? ` text-anchor="${anchor}"` : ''}>${clip(info.name, m.name, info.category ? textW : textW - m.logo - 2)}</text>`;
    if (info.category)
      text += `<text x="${tx}" y="${y + px(m.name + 1.7)}" font-family="sans-serif" font-size="${font(m.cat)}" fill="#333"${anchor ? ` text-anchor="${anchor}"` : ''}>${clip(info.category, m.cat, textW - m.logo - 2)}</text>`;
  } else {
    // Vertical blanks: lines fill the middle band between logo and QR.
    const lines = (m.vertical ? [0.28, 0.38, 0.48] : [0.36, 0.62, 0.88]).map((f) =>
      Math.round(ch * f),
    );
    text = lines
      .map(
        (y, i) =>
          `<line x1="${m.vertical ? px(4) : textX}" y1="${y}" x2="${cw - px(m.vertical ? 4 : i === 2 ? m.logo + 1 : 4)}" y2="${y}" stroke="#000" stroke-width="${Math.max(1, px(0.4))}" />`,
      )
      .join('');
  }
  const logoSide = px(m.logo);
  let logo = '';
  try {
    const logoBuf = await fs.readFile(path.join(process.cwd(), 'client', 'dist', 'logo-mono.svg'));
    logo = `<image href="data:image/svg+xml;base64,${logoBuf.toString('base64')}" x="${m.vertical ? Math.round((cw - logoSide) / 2) : cw - logoSide - px(0.8)}" y="${m.vertical ? px(1) : ch - logoSide - px(0.5)}" width="${logoSide}" height="${logoSide}"/>`;
  } catch {
    // logo asset missing - cells still print fine without it
  }
  const qrX = m.vertical ? Math.round((cw - qrSide) / 2) : 0;
  const qrY = m.vertical ? ch - qrSide - px(m.code + 2.5) : Math.round((ch - qrSide) / 2) - px(2);
  const codeX = m.vertical ? Math.round(cw / 2) : Math.round(qrSide / 2);
  return Buffer.from(
    `<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg">
      <image href="${qrB64}" x="${qrX}" y="${qrY}" width="${qrSide}" height="${qrSide}"/>
      <text x="${codeX}" y="${qrY + qrSide + px(1)}" font-family="monospace" font-size="${font(m.code)}" fill="#444" text-anchor="middle">${esc(info.code)}</text>
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
  if (p.type === 'zpl' || p.type === 'zpl-legacy') return printZpl(p, codes, origin);
  if (p.type === 'cups')
    return p.mediaType === 'sheet' ? printCupsSheet(p, codes, origin) : printCups(p, codes, origin);
  throw new Error(`printer type ${p.type} is printed from the browser`);
}
