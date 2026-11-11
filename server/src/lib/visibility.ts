import { eq, or, and, sql, type SQL } from 'drizzle-orm';
import { areas, items, objectShares } from '../db/schema';
import { db } from '../db';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Household visibility, file-permission style. An item or area is hidden
 * when a private constraint on its own row or any private ancestor bin
 * excludes the user (not owner, not on that object's share list).
 * `userId` null (MCP connections) sees shared only.
 * `isAdmin` bypasses BIN gates (admin can always see/un-private a bin) but
 * never an item's own private flag - the owner keeps it.
 *
 * The CTE seed aliases the areas table (`areas s`) - an un-aliased `areas.id`
 * in the seed would bind to the inner table instead of the outer row, which
 * made one private bin hide every bin from everyone outside it.
 */

/** One private ancestor gate: recursive walk up the area tree from `from`. */
const ancestorBlocked = (userId: string | null, isAdmin: boolean, from: SQLiteColumn | SQL) =>
  userId
    ? sql`exists (with recursive anc(id,parent_id) as (
        select s.id, s.parent_id from areas s where s.id = ${from}
        union all select a.id,a.parent_id from areas a join anc on a.id = anc.parent_id
      ) select 1 from anc join areas pa on pa.id = anc.id
        where pa.is_private = 1 and coalesce(pa.owner_id,'') <> ${userId}
          and ${isAdmin ? sql`0` : sql`1`} = 1
          and not exists (
            select 1 from object_shares os
            where os.object_type = 'area' and os.object_id = pa.id and os.user_id = ${userId}
          ))`
    : sql`exists (with recursive anc(id,parent_id) as (
        select s.id, s.parent_id from areas s where s.id = ${from}
        union all select a.id,a.parent_id from areas a join anc on a.id = anc.parent_id
      ) select 1 from anc join areas pa on pa.id = anc.id where pa.is_private = 1)`;

export const itemVisible = (userId: string | null, isAdmin = false) => {
  const itemOk = userId
    ? or(
        eq(items.isPrivate, false),
        eq(items.ownerId, userId),
        sql`exists (select 1 from object_shares os where os.object_type = 'item' and os.object_id = ${items.id} and os.user_id = ${userId})`,
      )
    : eq(items.isPrivate, false);
  return and(itemOk, sql`not ${ancestorBlocked(userId, isAdmin, items.areaId)}`);
};

export const areaVisible = (userId: string | null, isAdmin = false) =>
  sql`not ${ancestorBlocked(userId, isAdmin, areas.id)}`;

/** Same rule as raw SQL for queries that filter with hand-written text.
 *  `itemAlias` is the items alias in that query (e.g. 'i' or 'items'). */
export const itemVisibleSql = (itemAlias: string, userId: string | null, isAdmin = false) =>
  userId
    ? sql`(${sql.raw(itemAlias)}.is_private = 0
        or ${sql.raw(itemAlias)}.owner_id = ${userId}
        or exists (select 1 from object_shares os where os.object_type = 'item' and os.object_id = ${sql.raw(itemAlias)}.id and os.user_id = ${userId}))
        and not ${ancestorBlocked(userId, isAdmin, sql.raw(`${itemAlias}.area_id`))}`
    : sql`${sql.raw(itemAlias)}.is_private = 0 and not ${ancestorBlocked(null, false, sql.raw(`${itemAlias}.area_id`))}`;

/** Per-object checks for routes - walk the chain in code (depth is small). */
export async function canSeeArea(areaId: string | null, userId: string | null, isAdmin = false) {
  if (isAdmin) return true;
  if (!areaId) return true;
  let id: string | null = areaId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const [a] = await db
      .select({ id: areas.id, parentId: areas.parentId, isPrivate: areas.isPrivate, ownerId: areas.ownerId })
      .from(areas)
      .where(eq(areas.id, id));
    if (!a) return true; // missing row - the route's own 404 handles it
    if (a.isPrivate && a.ownerId !== userId) {
      if (!userId) return false;
      const [share] = await db
        .select({ userId: objectShares.userId })
        .from(objectShares)
        .where(and(eq(objectShares.objectType, 'area'), eq(objectShares.objectId, a.id), eq(objectShares.userId, userId)))
        .limit(1);
      if (!share) return false;
    }
    id = a.parentId;
  }
  return true;
}

export async function canSeeItem(item: { id: string; isPrivate: boolean; ownerId: string | null; areaId: string | null }, userId: string | null, isAdmin = false) {
  if (item.isPrivate) {
    // A private item needs an owner match or an explicit share - null
    // viewers and ownerless private items are never inside the set.
    if (!userId) return false;
    if (item.ownerId !== userId) {
      const [share] = await db
        .select({ userId: objectShares.userId })
        .from(objectShares)
        .where(and(eq(objectShares.objectType, 'item'), eq(objectShares.objectId, item.id), eq(objectShares.userId, userId)))
        .limit(1);
      if (!share) return false;
    }
  }
  return canSeeArea(item.areaId, userId, isAdmin);
}

/** Plain-text version for `query`/`queryOne` (positional ? params).
 *  Returns the clause text + the params to append (uid appears 4x). */
export function itemVisibleWhere(itemAlias: string, userId: string | null, isAdmin = false) {
  const a = itemAlias;
  const cte = `with recursive anc(id,parent_id) as (
      select s.id,s.parent_id from areas s where s.id = ${a}.area_id
      union all select x.id,x.parent_id from areas x join anc on x.id = anc.parent_id
    ) select 1 from anc join areas pa on pa.id = anc.id`;
  if (!userId) {
    return {
      text: `${a}.is_private = 0 and not exists (${cte} where pa.is_private = 1)`,
      params: [] as unknown[],
    };
  }
  return {
    text: `(${a}.is_private = 0 or ${a}.owner_id = ? or exists (
        select 1 from object_shares os where os.object_type = 'item' and os.object_id = ${a}.id and os.user_id = ?))
      and not exists (${cte}
        where pa.is_private = 1 and coalesce(pa.owner_id,'') <> ?
          and ${isAdmin ? '0' : '1'} = 1
          and not exists (
            select 1 from object_shares os where os.object_type = 'area' and os.object_id = pa.id and os.user_id = ?))`,
    params: [userId, userId, userId, userId],
  };
}

/** Role-aware user shorthand used across routes. */
export const isAdmin = (req: { user: { id: string; role?: string } | null }) =>
  req.user?.role === 'admin';
