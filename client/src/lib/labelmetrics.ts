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
  /** Vertical labels get a bigger logo, centered at the bottom. */
  logoCenter: boolean;
  padding: number;
}

export function labelMetrics(wMm: number, hMm: number): LabelMetrics {
  const vertical = hMm > wMm * 1.4;
  // Scale fonts/logo with the shorter dimension; 25.4mm is the reference
  // label height the layout was originally tuned for.
  const s = Math.min(3, Math.max(1, Math.min(wMm, hMm) / 25.4));
  return {
    vertical,
    qr: vertical ? Math.min(wMm * 0.72, hMm * 0.42) : Math.min(hMm - 2.1 * s - 1, wMm * 0.5),
    code: 2.1 * s,
    path: 2.3 * s,
    name: 3.4 * s,
    category: 2.3 * s,
    logo: vertical
      ? Math.min(hMm * 0.22, wMm * 0.6, 48)
      : Math.min(10 * s, hMm * 0.25, wMm * 0.3),
    logoCenter: vertical,
    padding: Math.min(3 * s, 8),
  };
}
