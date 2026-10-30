import { query } from '../db';



export interface Crumb {
  id: string;
  parent_id: string | null;
  name: string | null;
  cover_photo_id: string | null;
}

/** Path from root down to (and including) the given area. */
export async function breadcrumb(areaId: string): Promise<Crumb[]> {
  return query<Crumb>(
    `WITH RECURSIVE chain AS (
      SELECT id, parent_id, name, cover_photo_id, 0 AS depth
      FROM areas WHERE id = ?
      UNION ALL
      SELECT a.id, a.parent_id, a.name, a.cover_photo_id, c.depth + 1
      FROM areas a
      JOIN chain c ON a.id = c.parent_id
      WHERE c.depth < 32
    )
    SELECT id, parent_id, name, cover_photo_id FROM chain ORDER BY depth DESC`,
    areaId,
  );
}

/** The area plus every nested area beneath it (itself first). */
export async function descendantAreaIds(areaId: string): Promise<string[]> {
  const rows = query<{ id: string }>(
    `WITH RECURSIVE tree AS (
      SELECT id, 0 AS depth FROM areas WHERE id = ?
      UNION ALL
      SELECT a.id, t.depth + 1 FROM areas a
      JOIN tree t ON a.parent_id = t.id
      WHERE t.depth < 32
    ) SELECT id FROM tree`,
    areaId,
  );
  return rows.map((r) => r.id);
}

/** Visible-item counts for a batch of areas, each counting its whole subtree. */
export async function subtreeItemCounts(
  areaIds: string[],
  userId: string | null,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!areaIds.length) return map;
  const ph = areaIds.map(() => '?').join(',');
  const rows = query<{ root: string; n: number }>(
    `WITH RECURSIVE tree AS (
      SELECT id, id AS root, 0 AS depth FROM areas WHERE id IN (${ph})
      UNION ALL
      SELECT a.id, t.root, t.depth + 1 FROM areas a
      JOIN tree t ON a.parent_id = t.id
      WHERE t.depth < 32
    )
    SELECT t.root, COUNT(i.id) AS n
      FROM tree t
      LEFT JOIN items i ON i.area_id = t.id AND i.hidden_at IS NULL
        AND (i.is_private = 0 OR i.owner_id = ?)
     GROUP BY t.root`,
    ...areaIds,
    userId,
  );
  for (const r of rows) map.set(r.root, r.n);
  return map;
}
