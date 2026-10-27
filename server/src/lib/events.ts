import { eq } from 'drizzle-orm';
import { db } from '../db';
import { areas, events, items } from '../db/schema';

export type EventType =
  | 'area.created'
  | 'area.moved'
  | 'area.updated'
  | 'area.archived'
  | 'item.filed'
  | 'item.moved'
  | 'item.updated'
  | 'item.status'
  | 'item.hidden'
  | 'item.not_here';

export async function recordEvent(
  type: EventType,
  entityType: 'area' | 'item',
  entityId: string,
  payload: Record<string, unknown> = {},
) {
  const [row] = await db
    .insert(events)
    .values({ type, entityType, entityId, payload })
    .returning();
  return row;
}

/**
 * Applies the inverse of an event and marks it undone.
 * Undo never destroys data — filing an item is undone by hiding it, etc.
 */
export async function undoEvent(id: string): Promise<{ ok: boolean; message?: string }> {
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  if (!ev) return { ok: false, message: 'event not found' };
  if (ev.undoneAt) return { ok: false, message: 'already undone' };
  const entityId = ev.entityId!;
  const p = (ev.payload ?? {}) as Record<string, any>;

  switch (ev.type) {
    case 'item.filed':
      await db.update(items).set({ hiddenAt: new Date() }).where(eq(items.id, entityId));
      break;
    case 'item.moved':
      await db.update(items).set({ areaId: p.from_area_id }).where(eq(items.id, entityId));
      break;
    case 'item.hidden':
      await db.update(items).set({ hiddenAt: null }).where(eq(items.id, entityId));
      break;
    case 'item.not_here':
      await db
        .update(items)
        .set({ notHereCount: p.count_before ?? 0 })
        .where(eq(items.id, entityId));
      break;
    case 'item.status':
      await db
        .update(items)
        .set({ status: p.prev.status, lentTo: p.prev.lent_to, outSince: p.prev.out_since })
        .where(eq(items.id, entityId));
      break;
    case 'item.updated': {
      const prev = p.prev ?? {};
      await db
        .update(items)
        .set({
          name: prev.name,
          description: prev.description,
          quantity: prev.quantity,
          barcode: prev.barcode,
        })
        .where(eq(items.id, entityId));
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
