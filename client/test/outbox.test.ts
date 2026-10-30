import { indexedDB } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wire the IDB shim before importing the module under test.
(globalThis as any).indexedDB = indexedDB;

const { outboxAdd, outboxAll, outboxCount, drainOutbox } = await import('../src/outbox');
const { api } = await import('../src/api');

const wipe = () =>
  new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('stache-outbox');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });

const okRes = () =>
  new Response(JSON.stringify({ item: { id: 'i1' } }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
const errRes = (status: number, msg = 'nope') =>
  new Response(JSON.stringify({ message: msg }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const op = (n: number) => ({
  kind: 'file-item' as const,
  fields: { area_id: 'a', client_id: `c${n}` },
  blobs: [new Blob(['x'])],
  createdAt: Date.now() + n,
});

beforeEach(async () => {
  await wipe();
  vi.restoreAllMocks();
});

describe('drainOutbox', () => {
  it('uploads queued ops in order and empties the queue', async () => {
    const calls: string[] = [];
    vi.spyOn(api, 'fileItem').mockImplementation(async (f: any) => {
      calls.push(f.client_id);
      return { item: {} };
    });
    await outboxAdd(op(1));
    await outboxAdd(op(2));
    expect(await outboxCount()).toBe(2);

    const remaining = await drainOutbox();
    expect(remaining).toBe(0);
    expect(calls).toEqual(['c1', 'c2']);
    expect(await outboxAll()).toHaveLength(0);
  });

  it('parks 4xx rejects (never retried) and keeps draining the rest', async () => {
    vi.spyOn(api, 'fileItem')
      .mockRejectedValueOnce(new (await import('../src/api')).ApiError(400, 'bad area'))
      .mockResolvedValue({ item: {} });
    await outboxAdd(op(1));
    await outboxAdd(op(2));

    const remaining = await drainOutbox();
    expect(remaining).toBe(0); // parked ops don't count as queued
    const all = await outboxAll();
    expect(all).toHaveLength(1);
    expect(all[0].failed).toBe(true);
    expect(all[0].fields.client_id).toBe('c1');
  });

  it('stops on network failure and leaves everything queued', async () => {
    vi.spyOn(api, 'fileItem').mockRejectedValue(new TypeError('fetch failed'));
    await outboxAdd(op(1));
    await outboxAdd(op(2));

    const remaining = await drainOutbox();
    expect(remaining).toBe(2);
    const all = await outboxAll();
    expect(all.every((o) => !o.failed)).toBe(true);
  });

  it('stops on 5xx too - a sick server is retried later, not parked', async () => {
    const spy = vi.spyOn(api, 'fileItem').mockRejectedValue(
      new (await import('../src/api')).ApiError(502, 'bad gateway'),
    );
    await outboxAdd(op(1));

    expect(await drainOutbox()).toBe(1);
    const [o] = await outboxAll();
    expect(o.failed).toBeUndefined();
    // Second drain retries the same op (call count grows).
    await drainOutbox();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a retried replay hits the same client_id (server dedups)', async () => {
    // First attempt "lands" but the response is lost - retry replays the
    // identical op. The server's client_id check makes it idempotent;
    // client-side we just verify the same payload goes out twice.
    const spy = vi.spyOn(api, 'fileItem')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({ item: {}, deduped: true });
    await outboxAdd(op(1));

    await drainOutbox();
    await drainOutbox();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0].client_id).toBe(spy.mock.calls[1][0].client_id);
    expect(await outboxCount()).toBe(0);
  });
});
