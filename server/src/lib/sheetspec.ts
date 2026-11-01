/**
 * Sheet template specs for die-cut label sheets (Avery-style). A printer
 * stores a SheetChoice ({ preset } or { custom }) which resolves to a
 * SheetSpec used for both browser printing and CUPS sheet rendering.
 * All dimensions in millimetres; geometry is approximate - verify against
 * the physical sheet before a big batch.
 */
export interface SheetSpec {
  page: 'letter' | 'a4';
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gapX: number;
  gapY: number;
  marginTop: number;
  marginX: number;
}

export type SheetChoice = { preset?: string; custom?: Partial<SheetSpec> };

export const PAGE_SIZES = {
  letter: { w: 215.9, h: 279.4 },
  a4: { w: 210, h: 297 },
} as const;

export const SHEET_PRESETS: { id: string; name: string; spec: SheetSpec }[] = [
  {
    id: 'avery-5160',
    name: 'Avery 5160 / 5260 / 8160 (30-up)',
    spec: { page: 'letter', cols: 3, rows: 10, cellW: 66.675, cellH: 25.4, gapX: 3.175, gapY: 0, marginTop: 12.7, marginX: 4.76 },
  },
  {
    id: 'avery-5161',
    name: 'Avery 5161 / 8161 (20-up, 4×1in)',
    spec: { page: 'letter', cols: 2, rows: 10, cellW: 101.6, cellH: 25.4, gapX: 9.5, gapY: 0, marginTop: 12.7, marginX: 4.76 },
  },
  {
    id: 'avery-5163',
    name: 'Avery 5163 / 8163 (10-up, 4×2in)',
    spec: { page: 'letter', cols: 2, rows: 5, cellW: 101.6, cellH: 50.8, gapX: 4.76, gapY: 0, marginTop: 12.7, marginX: 4.76 },
  },
  {
    id: 'avery-5167',
    name: 'Avery 5167 (80-up, 2×½in)',
    spec: { page: 'letter', cols: 4, rows: 20, cellW: 50.8, cellH: 12.7, gapX: 3.175, gapY: 0, marginTop: 12.7, marginX: 6.35 },
  },
  {
    id: 'avery-5120',
    name: 'Avery 5120 (30-up, 1.5in square cells)',
    spec: { page: 'letter', cols: 5, rows: 6, cellW: 38.1, cellH: 38.1, gapX: 0, gapY: 0, marginTop: 25.4, marginX: 12.7 },
  },
  {
    id: 'avery-l7651',
    name: 'Avery L7651 (A4, 65-up)',
    spec: { page: 'a4', cols: 5, rows: 13, cellW: 38.1, cellH: 21.2, gapX: 2.54, gapY: 0, marginTop: 10.7, marginX: 4.83 },
  },
];

/** Resolve a stored SheetChoice to a concrete spec. */
export function resolveSheet(choice: SheetChoice | null | undefined): SheetSpec | null {
  if (!choice) return null;
  if (choice.custom && typeof choice.custom === 'object') {
    const c = choice.custom;
    const spec: SheetSpec = {
      page: c.page === 'a4' ? 'a4' : 'letter',
      cols: Math.max(1, Math.floor(Number(c.cols)) || 1),
      rows: Math.max(1, Math.floor(Number(c.rows)) || 1),
      cellW: Number(c.cellW) > 0 ? Number(c.cellW) : 66.675,
      cellH: Number(c.cellH) > 0 ? Number(c.cellH) : 25.4,
      gapX: Math.max(0, Number(c.gapX) || 0),
      gapY: Math.max(0, Number(c.gapY) || 0),
      marginTop: Math.max(0, Number(c.marginTop) || 0),
      marginX: Math.max(0, Number(c.marginX) || 0),
    };
    return spec;
  }
  const id = choice.preset ?? 'avery-5160';
  return SHEET_PRESETS.find((p) => p.id === id)?.spec ?? SHEET_PRESETS[0].spec;
}

export const DEFAULT_SHEET: SheetChoice = { preset: 'avery-5160' };
