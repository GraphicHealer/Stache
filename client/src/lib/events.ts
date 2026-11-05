/**
 * Translate internal event types into natural language for activity/history.
 * Never expose raw `item.hidden`-style identifiers to users.
 */
export function describeEvent(e: { type: string; entity_name?: string | null; payload?: any }): string {
  const p = e.payload ?? {};
  const n = e.entity_name;
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
