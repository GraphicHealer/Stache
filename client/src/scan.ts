export type Scan =
  | { kind: 'label'; code: string }
  | { kind: 'barcode'; value: string };

/**
 * Detect the first product barcode in a photo - native BarcodeDetector with a
 * @zxing fallback. Skips Stache's own labels (those parse as 'label').
 */
export async function detectBarcodeInPhoto(blob: Blob): Promise<{ format: string; text: string } | null> {
  const isProduct = (t: string) => parseScan(t)?.kind === 'barcode';
  if ('BarcodeDetector' in window) {
    try {
      const bmp = await createImageBitmap(blob);
      const formats = await (window as any).BarcodeDetector.getSupportedFormats();
      const found = await new (window as any).BarcodeDetector({ formats }).detect(bmp);
      const hit = found.find((r: any) => r.rawValue && isProduct(r.rawValue));
      if (hit) return { format: hit.format ?? 'barcode', text: hit.rawValue };
    } catch {
      /* fall through to zxing */
    }
  }
  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const res = await new BrowserMultiFormatReader().decodeFromImageElement(img);
      const text = res?.getText();
      if (text && isProduct(text)) return { format: res.getBarcodeFormat().toString(), text };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    /* no code found */
  }
  return null;
}

/** Interprets raw scanner text: a label URL, a label code, or a product barcode. */
export function parseScan(text: string): Scan | null {
  const t = text.trim();
  if (!t) return null;
  const urlMatch = t.match(/\/l\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return { kind: 'label', code: urlMatch[1].toUpperCase() };
  if (/^ST-\d+$/i.test(t)) return { kind: 'label', code: t.toUpperCase() };
  if (/^\d{1,6}$/.test(t)) return { kind: 'label', code: `ST-${t.padStart(6, '0')}` };
  return { kind: 'barcode', value: t };
}
