import { api } from './api';

// Operations that failed while offline sit here until they can be replayed.
export interface OutboxOp {
  id?: number;
  kind: 'file-item';
  fields: Record<string, string>;
  blobs: Blob[];
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('stash-outbox', 1);
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
export const outboxCount = (): Promise<number> => tx('readonly', (s) => s.count());

/** Replays queued ops in order. Stops at the first failure (still offline?). */
export async function drainOutbox(): Promise<number> {
  const ops = await outboxAll();
  for (const op of ops) {
    try {
      if (op.kind === 'file-item') await api.fileItem(op.fields, op.blobs);
      await outboxRemove(op.id!);
    } catch {
      break;
    }
  }
  return outboxCount();
}
