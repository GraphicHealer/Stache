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
