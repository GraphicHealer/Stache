import { api, ApiError } from './api';

// Operations that failed while offline sit here until they can be replayed.
export interface OutboxOp {
  id?: number;
  kind: 'file-item';
  fields: Record<string, string>;
  blobs: Blob[];
  createdAt: number;
  /** Server rejected it (4xx) - parked so it stops blocking the queue. */
  failed?: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('stache-outbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('ops', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('ops', mode);
        const request = run(t.objectStore('ops'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const outboxAdd = (op: OutboxOp) => tx('readwrite', (s) => s.add(op));
export const outboxAll = (): Promise<OutboxOp[]> => tx('readonly', (s) => s.getAll() as IDBRequest<OutboxOp[]>);
export const outboxRemove = (id: number) => tx('readwrite', (s) => s.delete(id));
export const outboxPut = (op: OutboxOp) => tx('readwrite', (s) => s.put(op));
// Parked ops don't count as "queued" - they need attention, not a retry.
export const outboxCount = (): Promise<number> =>
  outboxAll().then((ops) => ops.filter((o) => !o.failed).length);

let draining = false;

/**
 * Replays queued ops in order. Network/server (5xx) failures stop the drain
 * and retry next tick; 4xx rejections park the op - replaying it would fail
 * forever and starve everything behind it. The lock keeps the boot/online/
 * interval triggers from double-uploading.
 */
export async function drainOutbox(): Promise<number> {
  if (draining) return outboxCount();
  draining = true;
  try {
    const ops = await outboxAll();
    for (const op of ops) {
      if (op.failed) continue;
      try {
        if (op.kind === 'file-item') await api.fileItem(op.fields, op.blobs);
        await outboxRemove(op.id!);
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          await outboxPut({ ...op, failed: true });
          continue;
        }
        break;
      }
    }
    return outboxCount();
  } finally {
    draining = false;
  }
}
