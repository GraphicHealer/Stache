import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

// Fresh temp DATA_DIR before any src import - env.ts reads it at load time.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-test-'));

let db: any, schema: any, itemVisible: any, undoEvent: any, recordEventTx: any;
let app: any, getAuth: any;

beforeAll(async () => {
  const { runMigrations } = await import('../src/migrate');
  await runMigrations(() => {});
  ({ db } = await import('../src/db'));
  schema = await import('../src/db/schema');
  ({ itemVisible } = await import('../src/lib/visibility'));
  ({ undoEvent, recordEventTx } = await import('../src/lib/events'));
  const authMod = await import('../src/auth');
  await authMod.initAuth();
  getAuth = authMod.getAuth;
  const { buildApp } = await import('../src/app');
  app = buildApp();
  await app.ready();
});

async function mkArea(name = 'bin') {
  const [a] = await db.insert(schema.areas).values({ name }).returning();
  return a;
}

async function mkUser(id: string, role = 'member') {
  await db.insert(schema.user)
    .values({ id, name: id, email: `${id}@t.dev`, emailVerified: false, role })
    .onConflictDoNothing();
}

/** Real sign-up through Better Auth - returns a usable Cookie header + user id. */
async function login(email: string, role = 'member') {
  const res: any = await getAuth().api.signUpEmail({
    body: { name: email.split('@')[0], email, password: 'password-123' },
    returnHeaders: true,
  });
  const headers: Headers = res?.headers ?? res?.response?.headers;
  const setCookie = headers?.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (role !== 'member') {
    await db.update(schema.user).set({ role }).where(eq(schema.user.email, email));
  }
  const u = res?.response?.user ?? res?.user;
  return { cookie, userId: u?.id as string };
}

describe('visibility rules', () => {
  it('shared items are visible to everyone; private only to their owner', async () => {
    await mkUser('u1');
    await mkUser('u2');
    const a = await mkArea();
    const mk = (v: any) => db.insert(schema.items).values({ areaId: a.id, ...v }).returning();
    const [shared] = await mk({});
    const [mine] = await mk({ isPrivate: true, ownerId: 'u1' });
    const [theirs] = await mk({ isPrivate: true, ownerId: 'u2' });

    const ids = (uid: string | null) =>
      new Set(
        db.select({ id: schema.items.id }).from(schema.items)
          .where(itemVisible(uid)).all().map((r: any) => r.id),
      );

    expect(ids('u1').has(shared.id)).toBe(true);
    expect(ids('u1').has(mine.id)).toBe(true);
    expect(ids('u1').has(theirs.id)).toBe(false);
    expect(ids(null).has(mine.id)).toBe(false);
    expect(ids(null).has(shared.id)).toBe(true);
  });
});

describe('undoEvent', () => {
  it('reverses an item.moved event recorded atomically with the update', async () => {
    const a = await mkArea('a');
    const b = await mkArea('b');
    const [i] = await db.insert(schema.items).values({ areaId: a.id }).returning();

    const ev = db.transaction((tx: any) => {
      tx.update(schema.items).set({ areaId: b.id }).where(eq(schema.items.id, i.id)).run();
      return recordEventTx(
        tx, 'item.moved', 'item', i.id,
        { from_area_id: a.id, to_area_id: b.id }, 'u1',
      );
    });

    let [r] = await db.select().from(schema.items).where(eq(schema.items.id, i.id));
    expect(r.areaId).toBe(b.id);

    const res = await undoEvent(ev.id);
    expect(res.ok).toBe(true);
    [r] = await db.select().from(schema.items).where(eq(schema.items.id, i.id));
    expect(r.areaId).toBe(a.id);
  });

  it('stale undo is refused; undoing the newer event first unblocks it', async () => {
    const a = await mkArea('a2');
    const b = await mkArea('b2');
    const c = await mkArea('c2');
    const [i] = await db.insert(schema.items).values({ areaId: a.id }).returning();

    const mv = (to: string, from: string) =>
      db.transaction((tx: any) => {
        tx.update(schema.items).set({ areaId: to }).where(eq(schema.items.id, i.id)).run();
        return recordEventTx(
          tx, 'item.moved', 'item', i.id,
          { from_area_id: from, to_area_id: to }, 'u1',
        );
      });
    const ev1 = mv(b.id, a.id);
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at for ordering
    const ev2 = mv(c.id, b.id);

    expect((await undoEvent(ev1.id)).ok).toBe(false); // stale - B->C happened after
    let [r] = await db.select().from(schema.items).where(eq(schema.items.id, i.id));
    expect(r.areaId).toBe(c.id);

    expect((await undoEvent(ev2.id)).ok).toBe(true);  // C -> B
    expect((await undoEvent(ev1.id)).ok).toBe(true);  // now legal: B -> A
    [r] = await db.select().from(schema.items).where(eq(schema.items.id, i.id));
    expect(r.areaId).toBe(a.id);
  });

  it('undo of item.hidden restores visibility, and double-undo fails', async () => {
    const a = await mkArea();
    const [i] = await db.insert(schema.items).values({ areaId: a.id }).returning();
    const ev = db.transaction((tx: any) => {
      tx.update(schema.items).set({ hiddenAt: new Date() })
        .where(eq(schema.items.id, i.id)).run();
      return recordEventTx(tx, 'item.hidden', 'item', i.id, { name: 'x' }, 'u1');
    });
    expect((await undoEvent(ev.id)).ok).toBe(true);
    const [r] = await db.select().from(schema.items).where(eq(schema.items.id, i.id));
    expect(r.hiddenAt).toBeNull();
    expect((await undoEvent(ev.id)).ok).toBe(false);
  });
});

describe('label codes', () => {
  it('generates ST-XXXXXXXX codes from the unambiguous alphabet', async () => {
    const { newLabelCode, LABEL_CODE_RE } = await import('../src/lib/labelcode');
    const code = newLabelCode();
    expect(code).toMatch(LABEL_CODE_RE);
    expect(code).toMatch(/^ST-[2-9A-HJKM-NP-Z]{8}$/); // no 0/1/I/L/O
  });

  it('generates unique codes at scale', async () => {
    const { newLabelCode } = await import('../src/lib/labelcode');
    const codes = new Set(Array.from({ length: 5000 }, () => newLabelCode()));
    expect(codes.size).toBe(5000);
  });
});

describe('api (fastify.inject)', () => {
  it('health is open', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('protected routes 401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/areas' });
    expect(res.statusCode).toBe(401);
  });

  it('label batch endpoint 401s without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/batch',
      payload: { count: 5 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('members get the user list without emails; admins get emails', async () => {
    const member = await login('mem1@t.dev');
    const admin = await login('admin1@t.dev', 'admin');

    const mres = await app.inject({ method: 'GET', url: '/api/users', headers: member });
    expect(mres.statusCode).toBe(200);
    expect(mres.json().users.length).toBeGreaterThan(0);
    expect(mres.json().users.every((u: any) => !('email' in u))).toBe(true);

    const ares = await app.inject({ method: 'GET', url: '/api/users', headers: admin });
    expect(ares.json().users.some((u: any) => u.email)).toBe(true);
  });

  it('private item photos 404 for other members, serve for the owner', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.join(process.env.DATA_DIR!, 'photos');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ptest.webp'), Buffer.from('fake-image'));

    const owner = await login('owner@t.dev');
    const other = await login('other@t.dev');
    const a = await mkArea();
    const [i] = await db.insert(schema.items)
      .values({ areaId: a.id, isPrivate: true, ownerId: owner.userId })
      .returning();
    await db.insert(schema.photos)
      .values({ itemId: i.id, path: 'ptest.webp', thumbPath: 'ptest.webp' });

    const denied = await app.inject({ method: 'GET', url: '/photos/ptest.webp', headers: other });
    expect(denied.statusCode).toBe(404);
    const deniedThumb = await app.inject({ method: 'GET', url: '/photos/ptest.webp', headers: other });
    expect(deniedThumb.statusCode).toBe(404);

    const ok = await app.inject({ method: 'GET', url: '/photos/ptest.webp', headers: owner });
    expect(ok.statusCode).toBe(200);

    const anon = await app.inject({ method: 'GET', url: '/photos/ptest.webp' });
    expect(anon.statusCode).toBe(401);
  });

  it('setup is public (fixture users exist, so needs_setup is false)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.json().needs_setup).toBe(false);
  });
});
