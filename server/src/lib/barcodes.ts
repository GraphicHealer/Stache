import sharp from 'sharp';

export interface DetectedCode {
  format: string;
  text: string;
}

/** Stash's own labels — never treated as product codes. */
const isStashLabel = (t: string) => /\/l\/[A-Za-z0-9-]+/.test(t) || /^ST-\d+$/i.test(t);

/** Detect barcodes/QR codes in an image buffer (zxing-cpp via WASM). */
export async function detectCodes(buf: Buffer): Promise<DetectedCode[]> {
  try {
    const { readBarcodes } = await import('zxing-wasm/reader');
    // zxing's image decoder doesn't handle webp — normalize to png.
    const png = await sharp(buf).rotate().png().toBuffer();
    const results = await readBarcodes(png, { tryHarder: true });
    const seen = new Set<string>();
    return results
      .filter((r) => r.text && !r.error && !isStashLabel(r.text))
      .map((r) => ({ format: String(r.format), text: r.text! }))
      .filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
  } catch {
    return [];
  }
}

export interface ProductInfo {
  name: string;
  brand: string | null;
  source: string;
}

const LOOKUP_BASES = [
  'https://world.openfoodfacts.org',
  'https://world.openproductsfacts.org',
  'https://world.openbeautyfacts.org',
];

/** Free product lookup — Open*Facts APIs, first hit wins. */
export async function lookupBarcode(code: string): Promise<ProductInfo | null> {
  for (const base of LOOKUP_BASES) {
    try {
      const res = await fetch(`${base}/api/v2/product/${encodeURIComponent(code)}.json`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'StashInventory/0.1 (self-hosted)' },
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const name = data?.product?.product_name ?? data?.product?.product_name_en;
      if (name) {
        return {
          name,
          brand: data.product.brands ?? null,
          source: new URL(base).hostname,
        };
      }
    } catch {
      /* try next provider */
    }
  }
  return null;
}
