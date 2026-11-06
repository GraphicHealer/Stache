/**
 * Translate internal event types into natural language for activity/history.
 * Never expose raw `item.hidden`-style identifiers to users.
 */
export function describeEvent(e: { type: string; entity_name?: string | null; payload?: any }): string {
  const p = e.payload ?? {};
  // entity_name resolves from live rows; payloads keep a copy so the name
  // survives a purge (item.hidden already records one).
  const n = e.entity_name ?? p.name ?? null;
  const thing = n ? `"${n}"` : '';
  switch (e.type) {
    case 'item.filed': return `filed ${thing}`.trim();
    case 'item.moved': return `moved ${thing}`.trim();
    case 'item.updated': return `edited ${thing}`.trim();
    case 'item.status': return `marked ${thing} ${statusLabel(p.next?.status)}`.trim();
    case 'item.hidden': return `moved ${thing} to trash`.trim();
    case 'item.restored': return `restored ${thing}`.trim();
    case 'item.not_here': return `marked ${thing} not here`.trim();
    case 'item.linked': return `linked ${thing} to another item`.trim();
    case 'item.unlinked': return `unlinked ${thing}`.trim();
    case 'item.receipt_attached': return `attached a receipt to ${thing}`.trim();
    case 'item.receipt_detached': return `removed a receipt from ${thing}`.trim();
    case 'item.merged': return `merged ${thing} with a duplicate`.trim();
    case 'item.photo_replaced': return `re-shot the photo of ${thing}`.trim();
    case 'area.created': return `created area ${thing}`.trim();
    case 'area.updated': return `edited area ${thing}`.trim();
    case 'area.moved': return `moved area ${thing}`.trim();
    case 'area.archived': return `archived area ${thing}`.trim();
    case 'area.restored': return `restored area ${thing}`.trim();
    case 'area.merged': return `merged area ${thing}`.trim();
    case 'label.assigned': return `assigned label ${thing}`.trim();
    case 'label.unassigned': return `removed label ${thing}`.trim();
    case 'stocktake': return 'stocktake';
    default: return e.type;
  }
}

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago" / "Mar 5" for activity rows. */
export function relTime(iso: string | Date): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

function statusLabel(s: string | undefined): string {
  switch (s) {
    case 'home': return 'home';
    case 'out': return 'out';
    case 'lent': return 'lent';
    case 'unaccounted': return 'unaccounted';
    case 'gone': return 'gone';
    default: return 'changed';
  }
}
