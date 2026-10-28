import { query } from '../db';

/**
 * Fuzzy text search - JS port of the pg_trgm/fuzzystrmatch ranking the app
 * had on Postgres. At home-inventory scale (thousands of items) scanning
 * candidates in JS is instant and keeps the DB a plain SQLite file.
 */

/** pg_trgm-style similarity: Jaccard over padded 3-char shingles. */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const set = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}

export function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

/**
 * word_similarity equivalent: best trigram similarity between the query and
 * any contiguous word window of the text.
 */
export function wordSim(q: string, text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const qw = q.split(/\s+/).filter(Boolean).length || 1;
  let best = 0;
  for (const len of [qw - 1, qw, qw + 1]) {
    if (len < 1) continue;
    for (let i = 0; i + len <= words.length; i++) {
      best = Math.max(best, trigramSim(q, words.slice(i, i + len).join(' ')));
    }
  }
  if (words.length <= qw) best = Math.max(best, trigramSim(q, text));
  return best;
}

/** Levenshtein distance, early-exits past `cap` (we only test <= 2). */
export function levenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
    if (Math.min(...prev) > cap) return cap + 1;
  }
  return prev[b.length];
}

const SOUNDEX_MAP: Record<string, string> = {
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3',
  l: '4',
  m: '5', n: '5',
  r: '6',
};

/** American Soundex - equivalent of fuzzystrmatch's soundex(). */
export function soundex(s: string): string {
  const w = s.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  let code = w[0].toUpperCase();
  let prev = SOUNDEX_MAP[w[0]] ?? '';
  for (const ch of w.slice(1)) {
    const d = SOUNDEX_MAP[ch] ?? '';
    if (d && d !== prev) code += d;
    if (ch !== 'h' && ch !== 'w') prev = d;
    if (code.length >= 4) break;
  }
  return (code + '000').slice(0, 4);
}

/**
 * Match + score for an item against a query. Mirrors the old WHERE clause:
 * FTS hit, substring match, word_similarity > 0.3, levenshtein word <= 2,
 * soundex word, or exact barcode. Score feeds ORDER BY. `aiText` (joined
 * ai_name/ai_tags/ocr_text) matches too, but ranks below user-entered text.
 */
export function fuzzyItemScore(
  q: string,
  name: string | null,
  description: string | null,
  barcode: string | null,
  aiText = '',
): { matched: boolean; score: number } {
  const lq = q.toLowerCase();
  const ln = (name ?? '').toLowerCase();
  const ld = (description ?? '').toLowerCase();
  const la = aiText.toLowerCase();
  let score = Math.max(trigramSim(lq, ln), wordSim(lq, ln), wordSim(lq, ld));
  let matched = score > 0.3 || barcode === q;

  if (ln.includes(lq) || ld.includes(lq)) {
    matched = true;
    score = Math.max(score, 0.6);
  } else if (la.includes(lq)) {
    matched = true;
    score = Math.max(score, 0.5);
  }
  score = Math.max(score, wordSim(lq, la) * 0.6);
  if (wordSim(lq, la) > 0.3) matched = true;
  // Multi-word queries used to compare each name word against the whole
  // query string, so levenshtein/soundex never fired. Compare per-token.
  const qTokens = lq.split(/[^a-z0-9]+/).filter(Boolean);
  outer: for (const w of ln.split(/[^a-z0-9]+/)) {
    if (!w) continue;
    for (const t of qTokens) {
      if (levenshtein(w, t, 2) <= 2 || soundex(w) === soundex(t)) {
        matched = true;
        score = Math.max(score, 0.45);
        break outer;
      }
    }
  }
  if (barcode === q) score = Math.max(score, 1);
  return { matched, score };
}

/** FTS5 MATCH expression: every term must hit, as a prefix. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' AND ');
}

/**
 * Search visible items: FTS5 hits (bm25-ranked) unioned with fuzzy matches.
 * viewerId null = shared only (MCP); a user id = shared + their private.
 */
export function searchItemIds(
  q: string,
  viewerId: string | null,
  limit = 50,
): { id: string; score: number }[] {
  const ftsHits = new Map<string, number>();
  const fq = ftsQuery(q);
  if (fq) {
    try {
      for (const r of query<{ item_id: string; rank: number }>(
        `SELECT item_id, bm25(items_fts) AS rank FROM items_fts WHERE items_fts MATCH ?`,
        fq,
      )) {
        ftsHits.set(r.item_id, -r.rank); // bm25: lower is better
      }
    } catch {
      /* malformed FTS expression - fuzzy path still runs */
    }
  }

  const rows = query<{
    id: string;
    name: string | null;
    description: string | null;
    barcode: string | null;
    ai_name: string | null;
    ai_tags: string | null;
    ocr_text: string | null;
  }>(
    `SELECT id, name, description, barcode, ai_name, ai_tags, ocr_text FROM items
     WHERE hidden_at IS NULL AND (is_private = 0 OR owner_id = ?)`,
    viewerId,
  );

  const scored: { id: string; score: number }[] = [];
  for (const r of rows) {
    // ai_tags is a JSON array - strip the punctuation so words match cleanly.
    const aiText = [r.ai_name, r.ocr_text, r.ai_tags?.replace(/[[\]"]/g, ' ')]
      .filter(Boolean)
      .join(' ');
    const f = fuzzyItemScore(q, r.name, r.description, r.barcode, aiText);
    const rank = ftsHits.get(r.id);
    if (rank !== undefined || f.matched) {
      scored.push({ id: r.id, score: f.score + (rank !== undefined ? 0.5 + Math.min(1, rank / 10) : 0) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
