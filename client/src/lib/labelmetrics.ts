/** Size-aware label layout metrics (all values in mm). */
export interface LabelMetrics {
  /** Tall labels (h > 1.4×w) stack QR over centered text; wide ones go side-by-side. */
  vertical: boolean;
  qr: number;
  code: number;
  path: number;
  name: number;
  category: number;
  logo: number;
  padding: number;
}

export function labelMetrics(wMm: number, hMm: number): LabelMetrics {
  const vertical = hMm > wMm * 1.4;
  // Scale fonts/logo with the shorter dimension; 25.4mm is the reference
  // label height the layout was originally tuned for.
  const s = Math.min(3, Math.max(1, Math.min(wMm, hMm) / 25.4));
  return {
    vertical,
    qr: vertical ? Math.min(wMm * 0.55, hMm * 0.42) : Math.min(hMm * 0.82, wMm * 0.4),
    code: 2.1 * s,
    path: 2.3 * s,
    name: 3.4 * s,
    category: 2.3 * s,
    logo: Math.min(10 * s, hMm * 0.25, wMm * 0.3),
    padding: Math.min(3 * s, 8),
  };
}
