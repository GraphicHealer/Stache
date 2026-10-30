import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

// Fresh temp DATA_DIR before any src import - env.ts reads it at load time.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-review-test-'));

let db: any, schema: any, app: any, getAuth: any, undoEvent: any;

beforeAll(async () => {
  const { runMigrations } = await import('../src/migrate');
  await runMigrations(() => {});
  ({ db } = await import('../src/db'));
  schema = await import('../src/db/schema');
  ({ undoEvent } = await import('../src/lib/events'));
  const authMod = await import('../src/auth');
  await authMod.initAuth();
  getAuth = authMod.getAuth;
  const { buildApp } = await import('../src/app');
  app = buildApp();
  await app.ready();
});

async function mkArea(name = 'bin', parentId: string | null = null) {
  const [a] = await db.insert(schema.areas).values({ name, parentId }).returning();
  return a;
}

async function login(email: string, role = 'member') {
  const res: any = await getAuth().api.signUpEmail({
    body: { name: email.split('@')[0], email, password: 'password-123' },
    returnHeaders: true,
  });
  const headers: Headers = res?.headers ?? res?.response?.headers;
  const cookie = (headers?.get('set-cookie') ?? '').split(';')[0];
  if (role !== 'member') {
    await db.update(schema.user).set({ role }).where(eq(schema.user.email, email));
  }
  const u = res?.response?.user ?? res?.user;
  return { cookie, userId: u?.id as string };
}

describe('backup bundle', () => {
  it('round-trips plaintext: manifest + db + photos', async () => {
    const { buildBackup, unpackBackup } = await import('../src/lib/backup');
    const { buf } = await buildBackup({});
    const out = await unpackBackup(buf, null);
    expect(out.manifest.format).toBe('stache-backup');
    expect(out.manifest.encrypted).toBe(false);
    expect(out.manifest.counts.items).toBeGreaterThanOrEqual(0);
    expect(out.db.length).toBeGreaterThan(0);
  });

  it('encrypts the payload; wrong key fails, right key + stored key work', async () => {
    const { buildBackup, unpackBackup, RestoreError } = await import('../src/lib/backup');
    const enc = await buildBackup({ encrypt: true });
    expect(enc.key).toMatch(/^[0-9a-f]{64}$/);

    await expect(unpackBackup(enc.buf, null)).rejects.toThrow(RestoreError);
    await expect(unpackBackup(enc.buf, 'deadbeef'.repeat(8))).rejects.toThrow(RestoreError);
    const ok = await unpackBackup(enc.buf, enc.key);
    expect(ok.manifest.encrypted).toBe(true);
    expect(ok.db.length).toBeGreaterThan(0);

    // Opt-in: key embedded in the manifest - no external key needed.
    const selfContained = await buildBackup({ encrypt: true, includeKey: true });
    const ok2 = await unpackBackup(selfContained.buf, null);
    expect(ok2.manifest.key).toBe(selfContained.key);

    // Passphrase mode: scrypt-derived, no raw key in headers.
    const pass = await buildBackup({ encrypt: true, passphrase: 'hunter2' });
    expect(pass.key).toBeNull();
    await expect(unpackBackup(pass.buf, 'wrong')).rejects.toThrow(RestoreError);
    const ok3 = await unpackBackup(pass.buf, 'hunter2');
    expect(ok3.db.length).toBeGreaterThan(0);
  });

  it('scheduled backups: off by default, config persists, writeBundle produces a restorable zip', async () => {
    const { getBackupSchedule, setBackupSchedule, writeBundle, unpackBackup } = await import(
      '../src/lib/backup'
    );
    // Opt-in: disabled out of the box.
    const cfg0 = await getBackupSchedule();
    expect(cfg0.enabled).toBe(false);

    await setBackupSchedule({ enabled: true, interval_days: 2, keep: 5 });
    const cfg = await getBackupSchedule();
    expect(cfg).toEqual({ enabled: true, interval_days: 2, keep: 5 });

    const name = await writeBundle();
    expect(name).toMatch(/^stache-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
    const { promises: fsp } = await import('node:fs');
    const { env } = await import('../src/env');
    const buf = await fsp.readFile(path.join(env.dataDir, 'backups', name));
    const out = await unpackBackup(buf, null);
    expect(out.manifest.encrypted).toBe(false);
    expect(out.db.length).toBeGreaterThan(0);
  });

  it('backup-schedule endpoints are admin-only', async () => {
    const member = await login('sched-member@t.dev');
    const denied = await app.inject({
      method: 'GET', url: '/api/settings/backup-schedule', headers: member,
    });
    expect(denied.statusCode).toBe(403);
    const admin = await login('sched-admin@t.dev', 'admin');
    const res = await app.inject({
      method: 'PUT', url: '/api/settings/backup-schedule', headers: admin,
      payload: { enabled: true, interval_days: 3, keep: 4 },
    });
    expect(res.statusCode).toBe(200);
    const got = await app.inject({
      method: 'GET', url: '/api/settings/backup-schedule', headers: admin,
    });
    expect(got.json()).toEqual({ enabled: true, interval_days: 3, keep: 4 });
  });
});

describe('import', () => {
  it('dry-run previews, commit creates items in named + Unsorted areas', async () => {
    const admin = await login('imp-admin@t.dev', 'admin');
    const rows = [
      { name: 'hammer', area_name: 'Garage' },
      { name: 'mystery box' }, // no area -> Unsorted
      { name: 'bad', area_id: 'nope' }, // error row
    ];
    const dry = await app.inject({
      method: 'POST', url: '/api/import', headers: admin,
      payload: { items: rows, dry_run: true },
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().dry_run).toBe(true);
    expect(dry.json().create).toBe(2);
    expect(dry.json().errors).toHaveLength(1);
    expect(dry.json().new_areas).toContain('Garage');
    expect(dry.json().new_areas).toContain('Unsorted');

    const real = await app.inject({
      method: 'POST', url: '/api/import', headers: admin,
      payload: { items: rows },
    });
    expect(real.statusCode).toBe(201);
    expect(real.json().created).toHaveLength(2);
    expect(real.json().event_id).toBeTruthy();

    // Areas got created and items landed correctly.
    const garage = await db.select().from(schema.areas)
      .where(eq(schema.areas.name, 'Garage'));
    const unsorted = await db.select().from(schema.areas)
      .where(eq(schema.areas.name, 'Unsorted'));
    expect(garage.length).toBe(1);
    expect(unsorted.length).toBe(1);
    const [hammer] = await db.select().from(schema.items)
      .where(eq(schema.items.name, 'hammer'));
    const [mystery] = await db.select().from(schema.items)
      .where(eq(schema.items.name, 'mystery box'));
    expect(hammer.areaId).toBe(garage[0].id);
    expect(mystery.areaId).toBe(unsorted[0].id);

    // The whole import is undoable in one shot.
    expect((await undoEvent(real.json().event_id)).ok).toBe(true);
    const [gone] = await db.select().from(schema.items)
      .where(eq(schema.items.name, 'hammer'));
    expect(gone.hiddenAt).not.toBeNull();
  });
});

describe('links, receipts, merge', () => {
  it('link is symmetric + undoable', async () => {
    const u = await login('links@t.dev');
    const a = await mkArea('linkarea');
    const [x] = await db.insert(schema.items).values({ areaId: a.id, name: 'drill' }).returning();
    const [y] = await db.insert(schema.items).values({ areaId: a.id, name: 'bits' }).returning();

    const link = await app.inject({
      method: 'POST', url: `/api/items/${x.id}/links`, headers: u,
      payload: { item_id: y.id },
    });
    expect(link.statusCode).toBe(201);

    // Visible from both sides.
    for (const id of [x.id, y.id]) {
      const r = await app.inject({ method: 'GET', url: `/api/items/${id}/links`, headers: u });
      expect(r.json().links).toHaveLength(1);
    }
    expect((await undoEvent(link.json().event_id)).ok).toBe(true);
    const r = await app.inject({ method: 'GET', url: `/api/items/${x.id}/links`, headers: u });
    expect(r.json().links).toHaveLength(0);
  });

  it('merge moves photos + links, hides loser, undo restores', async () => {
    const u = await login('merge@t.dev');
    const a = await mkArea('mergearea');
    const [winner] = await db.insert(schema.items).values({ areaId: a.id, name: 'w' }).returning();
    const [loser] = await db.insert(schema.items).values({ areaId: a.id, name: 'l' }).returning();
    const [third] = await db.insert(schema.items).values({ areaId: a.id, name: 't' }).returning();
    const [pic] = await db.insert(schema.photos)
      .values({ itemId: loser.id, path: 'merge-p.webp', thumbPath: 'merge-p.webp' })
      .returning();
    await db.insert(schema.itemLinks)
      .values({ aId: [loser.id, third.id].sort()[0], bId: [loser.id, third.id].sort()[1] });

    const r = await app.inject({
      method: 'POST', url: `/api/items/${winner.id}/merge`, headers: u,
      payload: { item_id: loser.id },
    });
    expect(r.statusCode).toBe(200);

    let [p] = await db.select().from(schema.photos).where(eq(schema.photos.id, pic.id));
    expect(p.itemId).toBe(winner.id);
    let [l] = await db.select().from(schema.items).where(eq(schema.items.id, loser.id));
    expect(l.hiddenAt).not.toBeNull();
    // Loser's link re-pointed at the winner.
    const links = await app.inject({
      method: 'GET', url: `/api/items/${winner.id}/links`, headers: u,
    });
    expect(links.json().links.map((x: any) => x.id)).toContain(third.id);

    expect((await undoEvent(r.json().event_id)).ok).toBe(true);
    [p] = await db.select().from(schema.photos).where(eq(schema.photos.id, pic.id));
    expect(p.itemId).toBe(loser.id);
    [l] = await db.select().from(schema.items).where(eq(schema.items.id, loser.id));
    expect(l.hiddenAt).toBeNull();
  });
});

describe('hierarchy + history + tags', () => {
  it('deep area contents + descendant search + per-item history', async () => {
    const u = await login('deep@t.dev');
    const top = await mkArea('house');
    const mid = await mkArea('closet', top.id);
    const leaf = await mkArea('bin9', mid.id);
    const [deepItem] = await db.insert(schema.items)
      .values({ areaId: leaf.id, name: 'deep-thing', tags: ['winter', 'gear'] })
      .returning();

    const res = await app.inject({
      method: 'GET', url: `/api/areas/${top.id}?deep=1`, headers: u,
    });
    expect(res.json().items.map((i: any) => i.id)).toContain(deepItem.id);

    const search = await app.inject({
      method: 'GET', url: `/api/search?area_id=${top.id}&q=deep-thing`, headers: u,
    });
    expect(search.json().items.map((i: any) => i.id)).toContain(deepItem.id);

    // Tag filter + tag text search.
    const byTag = await app.inject({
      method: 'GET', url: `/api/search?tag=winter`, headers: u,
    });
    expect(byTag.json().items.map((i: any) => i.id)).toContain(deepItem.id);
    const byQ = await app.inject({
      method: 'GET', url: `/api/search?q=gear`, headers: u,
    });
    expect(byQ.json().items.map((i: any) => i.id)).toContain(deepItem.id);

    // History reflects real events.
    await app.inject({
      method: 'PATCH', url: `/api/items/${deepItem.id}`, headers: u,
      payload: { area_id: mid.id },
    });
    const hist = await app.inject({
      method: 'GET', url: `/api/items/${deepItem.id}/events`, headers: u,
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().events.some((e: any) => e.type === 'item.moved')).toBe(true);
  });

  it('review queue surfaces duplicates, unnamed, and failed-AI items', async () => {
    const u = await login('queue@t.dev');
    const a = await mkArea('qarea');
    const [orig] = await db.insert(schema.items).values({ areaId: a.id, name: 'orig' }).returning();
    const [dup] = await db.insert(schema.items)
      .values({ areaId: a.id, name: 'dup', duplicateOf: orig.id }).returning();
    await db.insert(schema.items).values({ areaId: a.id }); // unnamed
    await db.insert(schema.items)
      .values({ areaId: a.id, name: 'f', aiStatus: 'failed' });

    const r = await app.inject({ method: 'GET', url: '/api/review-queue', headers: u });
    expect(r.statusCode).toBe(200);
    expect(r.json().duplicates.map((d: any) => d.id)).toContain(dup.id);
    expect(r.json().duplicates[0].original.id).toBe(orig.id);
    expect(r.json().incomplete.length).toBeGreaterThan(0);
    expect(r.json().failed_ai.length).toBeGreaterThan(0);

    // "Not a dup" clears the flag via the normal PATCH path.
    const keep = await app.inject({
      method: 'PATCH', url: `/api/items/${dup.id}`, headers: u,
      payload: { duplicate_of: null },
    });
    expect(keep.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'GET', url: '/api/review-queue', headers: u });
    expect(r2.json().duplicates.map((d: any) => d.id)).not.toContain(dup.id);
  });
});
