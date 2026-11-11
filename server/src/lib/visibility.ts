import { eq, or, and, sql } from 'drizzle-orm';
import { areas, items } from '../db/schema';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Household visibility, file-permission style. An item or area is hidden
 * when a private constraint along its own row or any private ancestor bin
 * excludes the user (not owner, not on that object's share list).
 * `userId` null (MCP connections) sees shared only.
 */

/** One private ancestor gate: recursive walk up the area tree from `fromCol`. */
const ancestorBlocked = (userId: string | null, fromCol: SQLiteColumn) =>
  userId
    ? sql`exists (with recursive anc(id,parent_id) as (
        select id,parent_id from areas where id = ${fromCol}
        union all select a.id,a.parent_id from areas a join anc on a.id = anc.parent
      ) select 1 from anc join areas pa on pa.id = anc.id
        where pa.is_private = 1 and coalesce(pa.owner_id,'') <> ${userId}
          and not exists (
            select 1 from object_shares os
            where os.object_type = 'area' and os.object_id = pa.id and os.user_id = ${userId}
          ))`
    : sql`exists (with recursive anc(id,parent_id) as (
        select id,parent_id from areas where id = ${fromCol}
        union all select a.id,a.parent_id from areas a join anc on a.id = anc.parent
      ) select 1 from anc join areas pa on pa.id = anc.id where pa.is_private = 1)`;

export const itemVisible = (userId: string | null) => {
  const itemOk = userId
    ? or(
        eq(items.isPrivate, false),
        eq(items.ownerId, userId),
        sql`exists (select 1 from object_shares os where os.object_type = 'item' and os.object_id = ${items.id} and os.user_id = ${userId})`,
      )
    : eq(items.isPrivate, false);
  return and(itemOk, sql`not ${ancestorBlocked(userId, items.areaId)}`);
};

export const areaVisible = (userId: string | null) =>
  sql`not ${ancestorBlocked(userId, areas.id)}`;
