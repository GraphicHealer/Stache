import net from 'node:net';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import type { Printer } from '../db/schema';

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

/** Print via CUPS — needs `lp` in the image (cups-client) and a reachable server. */
export async function printCups(p: Printer, codes: string[], origin: string): Promise<void> {
  if (!p.queue) throw new Error('CUPS queue name not set');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stash-labels-'));
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

/** Server-side print dispatch. 'dymo' is client-side (DYMO Web Service). */
export async function printLabels(
  p: Printer,
  codes: string[],
  origin: string,
): Promise<void> {
  if (p.type === 'zpl') return printZpl(p, codes, origin);
  if (p.type === 'cups') return printCups(p, codes, origin);
  throw new Error(`printer type ${p.type} is printed from the browser`);
}
