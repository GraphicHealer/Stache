/** Minimal CSV parse - quoted fields, escaped quotes, CRLF all handled. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [''];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur[cur.length - 1] += '"';
          i++;
        } else inQ = false;
      } else cur[cur.length - 1] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') cur.push('');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rows.push(cur);
      cur = [''];
    } else cur[cur.length - 1] += ch;
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  description: 'note',
  desc: 'note',
  area: 'area_name',
  location: 'area_name',
  label: 'area_label',
};

/** JSON (array or {items:[…]}) or CSV with a header row → import rows. */
export function parseImportFile(text: string, filename: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (filename.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    const rows = Array.isArray(j) ? j : j.items;
    if (!Array.isArray(rows)) throw new Error('JSON must be an array or { items: […] }');
    return rows;
  }
  const lines = parseCsv(text);
  if (lines.length < 2) throw new Error('CSV needs a header row plus data rows');
  const headers = lines[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  return lines
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((cols) => {
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const v = cols[i]?.trim();
        if (!v) return;
        if (h === 'tags') row.tags = v.split(';').map((t) => t.trim()).filter(Boolean);
        else if (h === 'private') row.private = /^(1|true|yes)$/i.test(v);
        else row[h] = v;
      });
      return row;
    });
}
