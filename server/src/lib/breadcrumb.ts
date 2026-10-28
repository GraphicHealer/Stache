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
