// Lazy local ZPL→PNG renderer (zebrash wasm). init() runs once, on first use;
// the wasm is bundled by Vite as an asset so previews work fully offline.
let ready: Promise<typeof import('zpl-renderer-js/external')> | null = null;

const load = () =>
  (ready ??= (async () => {
    const mod = await import('zpl-renderer-js/external');
    const wasmUrl = (await import('zpl-renderer-js/wasm?url')).default;
    await mod.init({ wasmUrl });
    return mod;
  })());

/** Render ZPL to a base64 PNG. wMm/hMm in mm, dpi of the target printer. */
export async function renderZplPng(zpl: string, wMm: number, hMm: number, dpi: number): Promise<string> {
  const mod = await load();
  // zebrash sizes the canvas as mm*dpmm - must match the ZPL's dot units
  // (203dpi=8, 300dpi=12, 152dpi=6). A fractional dpmm shrinks the canvas
  // and crops content drawn at the real ^PW/^LL dot coordinates.
  return mod.zplToBase64Async(zpl, wMm, hMm, Math.round(dpi / 25.4));
}
