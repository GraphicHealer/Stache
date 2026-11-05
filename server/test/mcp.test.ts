import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-mcp-'));

let db: any, schema: any, app: any, getAuth: any;

beforeAll(async () => {
  const { runMigrations } = await import('../src/migrate');
  await runMigrations(() => {});
  ({ db } = await import('../src/db'));
  schema = await import('../src/db/schema');
  const authMod = await import('../src/auth');
  await authMod.initAuth();
  getAuth = authMod.getAuth;
  const { buildApp } = await import('../src/app');
  app = buildApp();
  await app.ready();
}, 90_000);

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
  return { cookie, userId: res?.response?.user?.id ?? res?.user?.id };
}

const rpc = (slug: string, token: string, method: string, params: any = {}) =>
  app.inject({
    method: 'POST',
    url: `/mcp/${slug}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });

describe('mcp endpoint', () => {
  let admin: any, member: any, slug = '', token = '';
  let sharedItem: any, privateItem: any;

  beforeAll(async () => {
    admin = await login('mcp-admin@t.dev', 'admin');
    member = await login('mcp-mem@t.dev');
    const [a] = await db.insert(schema.areas).values({ name: 'shed' }).returning();
    [sharedItem] = await db
      .insert(schema.items)
      .values({ areaId: a.id, name: 'mcp-shared-ladder' })
      .returning();
    [privateItem] = await db
      .insert(schema.items)
      .values({ areaId: a.id, name: 'mcp-private-journal', isPrivate: true, ownerId: member.userId })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/mcp',
      headers: admin,
      payload: { name: 'test-conn', scope: 'read-write' },
    });
    expect(res.statusCode).toBe(201);
    slug = res.json().connection.slug;
    token = res.json().token;
  }, 60_000);

  it('rejects bad/missing bearer tokens and unknown slugs', async () => {
    expect((await rpc(slug, 'wrong', 'tools/list')).statusCode).toBe(401);
    const noAuth = await app.inject({
      method: 'POST', url: `/mcp/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(noAuth.statusCode).toBe(401);
    expect((await rpc('nope-slug', token, 'tools/list')).statusCode).toBe(404);
  });

  it('item_details hides private items; shared items resolve', async () => {
    const denied = await rpc(slug, token, 'tools/call', {
      name: 'item_details', arguments: { item_id: privateItem.id },
    });
    expect(denied.body).toContain('not found');
    expect(denied.body).not.toContain('mcp-private-journal');

    const ok = await rpc(slug, token, 'tools/call', {
      name: 'item_details', arguments: { item_id: sharedItem.id },
    });
    expect(ok.body).toContain('mcp-shared-ladder');
  });

  it('search_items never surfaces private items', async () => {
    const res = await rpc(slug, token, 'tools/call', {
      name: 'search_items', arguments: { query: 'mcp-private' },
    });
    expect(res.body).not.toContain('mcp-private-journal');
    const hit = await rpc(slug, token, 'tools/call', {
      name: 'search_items', arguments: { query: 'mcp-shared' },
    });
    expect(hit.body).toContain('mcp-shared-ladder');
  });

  it('update_item refuses private items but writes shared ones', async () => {
    const denied = await rpc(slug, token, 'tools/call', {
      name: 'update_item',
      arguments: { item_id: privateItem.id, name: 'renamed-secret' },
    });
    expect(denied.body).toContain('not found');
    const [check] = await db.select().from(schema.items).where(eq(schema.items.id, privateItem.id));
    expect(check.name).toBe('mcp-private-journal');

    const ok = await rpc(slug, token, 'tools/call', {
      name: 'update_item',
      arguments: { item_id: sharedItem.id, name: 'mcp-renamed-ladder' },
    });
    expect(ok.body).toMatch(/changed\\?"?:\s*true/);
    const [after] = await db.select().from(schema.items).where(eq(schema.items.id, sharedItem.id));
    expect(after.name).toBe('mcp-renamed-ladder');
  });
});

describe('personal mcp connections', () => {
  let userA: any, userB: any;
  let aItem: any, bItem: any, shared2: any;
  let aSlug = '', aToken = '';

  const mkConn = async (cookie: string, scope = 'read-write') => {
    const res = await app.inject({
      method: 'POST', url: '/api/me/mcp-connections',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { name: 'my-assistant', scope },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { slug: body.connection.slug, token: body.token };
  };

  beforeAll(async () => {
    userA = await login('p-mcp-a@t.dev');
    userB = await login('p-mcp-b@t.dev');
    const [a] = await db.insert(schema.areas).values({ name: 'den' }).returning();
    [aItem] = await db.insert(schema.items)
      .values({ areaId: a.id, name: 'a-private-shelf', isPrivate: true, ownerId: userA.userId }).returning();
    [bItem] = await db.insert(schema.items)
      .values({ areaId: a.id, name: 'b-private-shelf', isPrivate: true, ownerId: userB.userId }).returning();
    [shared2] = await db.insert(schema.items)
      .values({ areaId: a.id, name: 'den-shared-piano' }).returning();
    ({ slug: aSlug, token: aToken } = await mkConn(userA.cookie));
  });

  it('any member can manage their own connections - no admin needed', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/me/mcp-connections', headers: { cookie: userA.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().connections.length).toBeGreaterThan(0);
    // and a member cannot see another user's connections
    const other = await app.inject({ method: 'GET', url: '/api/me/mcp-connections', headers: { cookie: userB.cookie } });
    expect(other.json().connections.length).toBe(0);
  });

  it("sees shared + own private items, never another member's private", async () => {
    const sharedHit = await rpc(aSlug, aToken, 'tools/call', {
      name: 'search_items', arguments: { query: 'den-shared-piano' },
    });
    expect(sharedHit.body).toContain('den-shared-piano');
    const ownHit = await rpc(aSlug, aToken, 'tools/call', {
      name: 'search_items', arguments: { query: 'a-private-shelf' },
    });
    expect(ownHit.body).toContain('a-private-shelf');
    const otherHit = await rpc(aSlug, aToken, 'tools/call', {
      name: 'search_items', arguments: { query: 'b-private-shelf' },
    });
    expect(otherHit.body).not.toContain('b-private-shelf');
  });

  it('direct-ID lookup cannot cross the owner boundary', async () => {
    const own = await rpc(aSlug, aToken, 'tools/call', {
      name: 'item_details', arguments: { item_id: aItem.id },
    });
    expect(own.body).toContain('a-private-shelf');
    const other = await rpc(aSlug, aToken, 'tools/call', {
      name: 'item_details', arguments: { item_id: bItem.id },
    });
    expect(other.body).toContain('not found');
    expect(other.body).not.toContain('b-private-shelf');
  });

  it("write tools work on own items but not another member's", async () => {
    const denied = await rpc(aSlug, aToken, 'tools/call', {
      name: 'update_item', arguments: { item_id: bItem.id, name: 'hijacked' },
    });
    expect(denied.body).toContain('not found');
    const [check] = await db.select().from(schema.items).where(eq(schema.items.id, bItem.id));
    expect(check.name).toBe('b-private-shelf');
    const ok = await rpc(aSlug, aToken, 'tools/call', {
      name: 'update_item', arguments: { item_id: aItem.id, name: 'a-renamed' },
    });
    expect(ok.body).toContain('changed');
  });

  it('read-only personal connections get no write tools', async () => {
    const ro = await mkConn(userA.cookie, 'read');
    const list = await rpc(ro.slug, ro.token, 'tools/list');
    expect(list.body).not.toContain('update_item');
    expect(list.body).not.toContain('add_item');
    expect(list.body).not.toContain('move_item');
    expect(list.body).toContain('search_items');
  });

  it('revoking a personal connection immediately stops auth', async () => {
    const doomed = await mkConn(userA.cookie);
    const list = await app.inject({ method: 'GET', url: '/api/me/mcp-connections', headers: { cookie: userA.cookie } });
    const conn = list.json().connections.find((c: any) => c.slug === doomed.slug);
    const del = await app.inject({
      method: 'DELETE', url: `/api/me/mcp-connections/${conn.id}`, headers: { cookie: userA.cookie },
    });
    expect(del.statusCode).toBe(200);
    const dead = await rpc(doomed.slug, doomed.token, 'tools/list');
    expect(dead.statusCode).toBe(404);
  });

  it('shared connections still cannot see any private items', async () => {
    // A shared (admin-created) connection stays shared-only even though this
    // same database now also hosts personal connections.
    const admin = await login('p-mcp-admin@t.dev', 'admin');
    const created = await app.inject({
      method: 'POST', url: '/api/settings/mcp',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      payload: { name: 'shared-ha' },
    });
    const { connection, token: sharedToken } = created.json();
    const res = await rpc(connection.slug, sharedToken, 'tools/call', {
      name: 'search_items', arguments: { query: 'private-shelf' },
    });
    expect(res.body).not.toContain('a-private-shelf');
    expect(res.body).not.toContain('b-private-shelf');
  });
});

