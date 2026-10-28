/**
 * Downscale a photo blob to at most `max` px per side before upload.
 * Cuts mobile bandwidth and IndexedDB outbox size ~5-10x; the server still
 * caps at 1600px, so nothing is lost beyond it anyway.
 */
export async function downscale(blob: Blob, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = bmp;
    if (Math.max(width, height) <= max) {
      bmp.close();
      return blob;
    }
    const scale = max / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, 'image/jpeg', 0.85),
    );
    return out ?? blob;
  } catch {
    // createImageBitmap/canvas unavailable - upload the original.
    return blob;
  }
}
