import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db, query } from '../db';
import { areas, events, itemLinks, itemReceipts, items, photos } from '../db/schema';
import { env } from '../env';

export type EventType =
  | 'area.created'
  | 'area.moved'
  | 'area.updated'
  | 'area.archived'
  | 'area.restored'
  | 'item.filed'
  | 'item.moved'
  | 'item.updated'
  | 'item.status'
  | 'item.hidden'
  | 'item.not_here'
  | 'item.restored'
  | 'item.linked'
  | 'item.unlinked'
  | 'item.receipt_attached'
  | 'item.receipt_detached'
  | 'item.merged'
  | 'item.photo_replaced'
  | 'stocktake';

/** Audit trail: who did it. NULL = MCP/system action. */
type UserId = string | null;

export async function recordEvent(
  type: EventType,
  entityType: 'area' | 'item' | 'multi',
  entityId: string,
  payload: Record<string, unknown> = {},
  userId: UserId = null,
  actor: string | null = null,
) {
  const [row] = await db
    .insert(events)
    .values({ type, entityType, entityId, payload, userId, actor })
    .returning();
  return row;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Same as recordEvent but inside a better-sqlite3 transaction - pair it with
 * the mutation it records so a failure can't leave an undoable ghost event.
 */
export function recordEventTx(
  tx: Tx,
  type: EventType,
  entityType: 'area' | 'item' | 'multi',
  entityId: string,
  payload: Record<string, unknown> = {},
  userId: UserId = null,
  actor: string | null = null,
) {
  return tx
    .insert(events)
    .values({ type, entityType, entityId, payload, userId, actor })
    .returning()
    .all()[0];
}

/** Keep the events table bounded - older events can't be undone anyway. */
export function pruneEvents(keepDays = 90, maxRows = 20_000): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).getTime();
  const r1 = query<{ n: number }>(
    `DELETE FROM events WHERE created_at < ? RETURNING 1 AS n`,
    cutoff,
  ).length;
  const r2 = query<{ n: number }>(
    `DELETE FROM events WHERE id NOT IN (
       SELECT id FROM events ORDER BY created_at DESC LIMIT ?
     ) RETURNING 1 AS n`,
    maxRows,
  ).length;
  return r1 + r2;
}

/**
 * Applies the inverse of an event and marks it undone.
 * Undo never destroys data - filing an item is undone by hiding it, etc.
 */
export async function undoEvent(id: string): Promise<{ ok: boolean; message?: string }> {
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  if (!ev) return { ok: false, message: 'event not found' };
  if (ev.undoneAt) return { ok: false, message: 'already undone' };
  const entityId = ev.entityId!;
  const p = (ev.payload ?? {}) as Record<string, any>;

  // Only the newest un-undone change to an entity can be reversed - undoing
  // an older event would silently overwrite the newer work.
  const newerOn = (entityType: string | null, eid: string) =>
    query<{ id: string }>(
      `SELECT id FROM events
        WHERE entity_type = ? AND entity_id = ? AND id != ?
          AND undone_at IS NULL AND created_at > ?
        LIMIT 1`,
      entityType,
      eid,
      ev.id,
      ev.createdAt.getTime(),
    ).length > 0;
  if (ev.entityType && newerOn(ev.entityType, entityId))
    return { ok: false, message: 'a newer change exists on this - undo that first' };

  switch (ev.type) {
    case 'item.filed': {
      // Single-file hides the item; a multi/import filing hides the batch.
      const ids = ev.entityType === 'multi' && Array.isArray(p.ids) && p.ids.length
        ? (p.ids as string[])
        : [entityId];
      await db.update(items).set({ hiddenAt: new Date() }).where(
        ids.length === 1 ? eq(items.id, ids[0]) : inArray(items.id, ids),
      );
      break;
    }
    case 'item.moved':
      await db.update(items).set({ areaId: p.from_area_id }).where(eq(items.id, entityId));
      break;
    case 'item.hidden':
      await db.update(items).set({ hiddenAt: null }).where(eq(items.id, entityId));
      break;
    case 'item.restored':
      await db.update(items).set({ hiddenAt: new Date() }).where(eq(items.id, entityId));
      break;
    case 'item.not_here':
      await db
        .update(items)
        .set({
          notHereCount: p.count_before ?? 0,
          status: p.status_before ?? 'home',
          ...(p.out_since_before !== undefined
            ? { outSince: p.out_since_before ? new Date(p.out_since_before) : null }
            : {}),
        })
        .where(eq(items.id, entityId));
      break;
    case 'item.status': {
      // Timestamps round-trip through JSONB as strings - coerce back to Date.
      const date = (v: unknown) => (v ? new Date(v as string) : null);
      await db
        .update(items)
        .set({
          status: p.prev.status,
          lentTo: p.prev.lent_to,
          outSince: date(p.prev.out_since),
          hiddenAt: date(p.prev.hidden_at),
          takeoutCount: p.prev.takeout_count ?? undefined,
          lastUsedAt: 'last_used' in p.prev ? date(p.prev.last_used) : undefined,
        })
        .where(eq(items.id, entityId));
      break;
    }
    case 'stocktake': {
      const date = (v: unknown) => (v ? new Date(v as string) : null);
      // Stocktake spans many items - refuse if any of them changed since.
      for (const c of (p.changes ?? []) as { id: string }[]) {
        if (newerOn('item', c.id))
          return { ok: false, message: 'an item changed since this stocktake - undo that first' };
      }
      for (const c of (p.changes ?? []) as { id: string; prev: any }[]) {
        await db
          .update(items)
          .set({
            status: c.prev.status,
            lentTo: c.prev.lent_to,
            outSince: date(c.prev.out_since),
            hiddenAt: date(c.prev.hidden_at),
            notHereCount: c.prev.not_here_count ?? undefined,
          })
          .where(eq(items.id, c.id));
      }
      break;
    }
    case 'item.updated': {
      // prev holds drizzle column keys for whatever fields changed.
      const prev = (p.prev ?? {}) as Record<string, unknown>;
      const allowed = new Set([
        'name', 'description', 'quantity', 'barcode',
        'detectedCodes', 'isPrivate', 'remindSnoozedUntil',
        'warrantyUntil', 'restockBelow',
        'purchaseDate', 'purchasePrice', 'retailer', 'serialNumber', 'tags',
        'duplicateOf',
      ]);
      const set = Object.fromEntries(
        Object.entries(prev)
          .filter(([k]) => allowed.has(k))
          .map(([k, v]) => [k, k === 'remindSnoozedUntil' && v ? new Date(v as string) : v]),
      );
      await db.update(items).set(set).where(eq(items.id, entityId));
      break;
    }
    case 'item.linked': {
      const [a, b] = [entityId, p.other_id].sort();
      await db.delete(itemLinks).where(and(eq(itemLinks.aId, a), eq(itemLinks.bId, b)));
      break;
    }
    case 'item.unlinked': {
      const [a, b] = [entityId, p.other_id].sort();
      await db.insert(itemLinks).values({ aId: a, bId: b }).onConflictDoNothing();
      break;
    }
    case 'item.receipt_attached':
      await db
        .delete(itemReceipts)
        .where(and(eq(itemReceipts.itemId, entityId), eq(itemReceipts.photoId, p.photo_id)));
      break;
    case 'item.receipt_detached':
      await db
        .insert(itemReceipts)
        .values({ itemId: entityId, photoId: p.photo_id })
        .onConflictDoNothing();
      break;
    case 'item.merged': {
      // Winner keeps nothing of the merge: photos + links go back to the
      // loser, which is unhidden.
      const loserId = p.loser_id as string;
      for (const pid of (p.moved_photo_ids ?? []) as string[]) {
        await db.update(photos).set({ itemId: loserId }).where(eq(photos.id, pid));
      }
      for (const l of (p.moved_links ?? []) as { other_id: string }[]) {
        const [a, b] = [loserId, l.other_id].sort();
        await db.insert(itemLinks).values({ aId: a, bId: b }).onConflictDoNothing();
        await db
          .delete(itemLinks)
          .where(and(eq(itemLinks.aId, [entityId, l.other_id].sort()[0]), eq(itemLinks.bId, [entityId, l.other_id].sort()[1])));
      }
      await db.update(items).set({ hiddenAt: null }).where(eq(items.id, loserId));
      break;
    }
    case 'item.photo_replaced': {
      await db
        .update(photos)
        .set({
          path: p.prev_path,
          thumbPath: p.prev_thumb,
          width: p.prev_width,
          height: p.prev_height,
        })
        .where(eq(photos.id, p.photo_id));
      for (const f of [p.new_path, p.new_thumb].filter(Boolean) as string[]) {
        fs.rm(path.join(env.dataDir, 'photos', f), { force: true }).catch(() => {});
      }
      break;
    }
    case 'area.created':
      await db.update(areas).set({ archivedAt: new Date() }).where(eq(areas.id, entityId));
      break;
    case 'area.moved':
      await db.update(areas).set({ parentId: p.from_parent_id }).where(eq(areas.id, entityId));
      break;
    case 'area.archived':
      await db.update(areas).set({ archivedAt: null }).where(eq(areas.id, entityId));
      break;
    case 'area.restored':
      await db.update(areas).set({ archivedAt: new Date() }).where(eq(areas.id, entityId));
      break;
    case 'area.updated':
      await db
        .update(areas)
        .set({ name: p.prev?.name, coverPhotoId: p.prev?.cover_photo_id })
        .where(eq(areas.id, entityId));
      break;
    default:
      return { ok: false, message: `cannot undo ${ev.type}` };
  }
  await db.update(events).set({ undoneAt: new Date() }).where(eq(events.id, id));
  return { ok: true };
}
