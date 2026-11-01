/** Client mirror of the server sheet-spec types. Presets come from
 *  GET /api/sheet-templates; custom specs are stored inline. */
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

export interface SheetPreset {
  id: string;
  name: string;
  spec: SheetSpec;
}

export const PAGE_SIZES = {
  letter: { w: 215.9, h: 279.4 },
  a4: { w: 210, h: 297 },
} as const;

export function resolveSheet(
  choice: SheetChoice | null | undefined,
  presets: SheetPreset[],
): SheetSpec | null {
  if (!choice) return null;
  if (choice.custom && typeof choice.custom === 'object') {
    const c = choice.custom;
    return {
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
  }
  const id = choice.preset ?? 'avery-5160';
  return presets.find((p) => p.id === id)?.spec ?? presets[0]?.spec ?? null;
}
