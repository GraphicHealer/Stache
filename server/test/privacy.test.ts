import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

// Fresh temp DATA_DIR before any src import - env.ts reads it at load time.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-priv-'));

let db: any, schema: any;
let app: any, getAuth: any, signPhotoUrl: any, webhookToken: any;

beforeAll(async () => {
  const { runMigrations } = await import('../src/migrate');
  await runMigrations(() => {});
  ({ db } = await import('../src/db'));
  schema = await import('../src/db/schema');
  ({ signPhotoUrl } = await import('../src/lib/signed'));
  ({ webhookToken } = await import('../src/lib/digest'));
  const authMod = await import('../src/auth');
  await authMod.initAuth();
  getAuth = authMod.getAuth;
  const { buildApp } = await import('../src/app');
  app = buildApp();
  await app.ready();
}, 90_000);

async function mkArea(name = 'area') {
  const [a] = await db.insert(schema.areas).values({ name }).returning();
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

// Fixture set shared across the suite: one shared item, one private item per
// user, all living in one area. Each test asserts the "other" user (and
// unauthenticated/webhook readers) can never see the private ones.
let owner: any, other: any, area: any;
let shared: any, mine: any, theirs: any;

beforeAll(async () => {
  owner = await login('po@t.dev');
  other = await login('px@t.dev');
  area = await mkArea('garage');
  const mk = (v: any) => db.insert(schema.items).values({ areaId: area.id, ...v }).returning();
  [shared] = await mk({ name: 'shared-drill' });
  [mine] = await mk({
    name: 'mine-passport',
    isPrivate: true,
    ownerId: owner.userId,
    tags: ['secrettag'],
    status: 'out',
    outSince: new Date(),
    quantity: 1,
    restockBelow: 5,
    warrantyUntil: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10),
  });
  [theirs] = await mk({ name: 'theirs-diary', isPrivate: true, ownerId: other.userId });
}, 60_000);

const get = (url: string, headers?: any) => app.inject({ method: 'GET', url, headers });

describe('item privacy - routes', () => {
  it('GET /api/items/:id 404s private items for other members, serves the owner', async () => {
    expect((await get(`/api/items/${mine.id}`, other)).statusCode).toBe(404);
    expect((await get(`/api/items/${mine.id}`, owner)).statusCode).toBe(200);
    expect((await get(`/api/items/${mine.id}`)).statusCode).toBe(401);
  });

  it('search never returns another member\'s private items', async () => {
    const me = (await get('/api/search?q=passport', owner)).json().items.map((i: any) => i.id);
    const them = (await get('/api/search?q=passport', other)).json().items.map((i: any) => i.id);
    expect(me).toContain(mine.id);
    expect(them).not.toContain(mine.id);
    const tagRes = (await get('/api/search?q=secrettag', other)).json().items.map((i: any) => i.id);
    expect(tagRes).not.toContain(mine.id);
  });

  it('search?private=1 cannot enumerate another member\'s private items', async () => {
    const ids = (await get('/api/search?private=1&status=out', other)).json().items.map((i: any) => i.id);
    expect(ids).not.toContain(mine.id);
  });

  it('area detail lists + counts exclude private items for non-owners', async () => {
    const res = (await get(`/api/areas/${area.id}`, other)).json();
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(mine.id);
    expect(ids).toContain(theirs.id); // their OWN private item is visible

    const mineRes = (await get(`/api/areas/${area.id}`, owner)).json();
    const myIds = mineRes.items.map((i: any) => i.id);
    expect(myIds).toContain(mine.id);
    expect(myIds).not.toContain(theirs.id);
  });

  it('suggest-tags does not leak private item tags to other members', async () => {
    const them = (await get(`/api/areas/${area.id}/suggest-tags`, other)).json().suggestions;
    expect(them).not.toContain('secrettag');
    const me = (await get(`/api/areas/${area.id}/suggest-tags`, owner)).json().suggestions;
    expect(me).toContain('secrettag');
  });

  it('out views + summary + webhook hide private items from everyone but the owner', async () => {
    const otherOut = (await get('/api/out', other)).json();
    expect(otherOut.out.map((i: any) => i.id)).not.toContain(mine.id);
    const myOut = (await get('/api/out', owner)).json();
    expect(myOut.out.map((i: any) => i.id)).toContain(mine.id);

    const sum = (await get('/api/out/summary', other)).json();
    expect(sum.items.map((i: any) => i.id)).not.toContain(mine.id);

    const token = await webhookToken();
    const sensor = (await get(`/api/webhooks/out-sensor?token=${token}`)).json();
    expect(sensor.items.map((i: any) => i.name)).not.toContain('mine-passport');
    expect(sensor.low_stock.map((i: any) => i.name)).not.toContain('mine-passport');
    expect(sensor.warranty_expiring.map((i: any) => i.name)).not.toContain('mine-passport');
  });

  it('webhook out-sensor 401s on a bad token', async () => {
    expect((await get('/api/webhooks/out-sensor?token=nope')).statusCode).toBe(401);
  });

  it('inbox + export + trash only show your own private items', async () => {
    const inbox = (await get('/api/inbox', other)).json();
    expect(inbox.low_stock.map((i: any) => i.id)).not.toContain(mine.id);
    expect(inbox.warranty_expiring.map((i: any) => i.id)).not.toContain(mine.id);

    const exp = (await get('/api/export', other)).json();
    expect(exp.items.map((i: any) => i.id)).not.toContain(mine.id);
    const myExp = (await get('/api/export', owner)).json();
    expect(myExp.items.map((i: any) => i.id)).toContain(mine.id);

    await db.update(schema.items).set({ hiddenAt: new Date() }).where(eq(schema.items.id, theirs.id));
    const trash = (await get('/api/trash', owner)).json();
    expect(trash.items.map((i: any) => i.id)).not.toContain(theirs.id);
    await db.update(schema.items).set({ hiddenAt: null }).where(eq(schema.items.id, theirs.id));
  });

  it('events feed hides private-item events from non-owners', async () => {
    const { recordEventTx } = await import('../src/lib/events');
    db.transaction((tx: any) =>
      recordEventTx(tx, 'item.updated', 'item', mine.id, { prev: { name: 'mine-passport' } }, owner.userId),
    );
    const feed = (await get('/api/events?limit=100', other)).json().events;
    expect(feed.every((e: any) => e.entity_id !== mine.id)).toBe(true);
    const myFeed = (await get('/api/events?limit=100', owner)).json().events;
    expect(myFeed.some((e: any) => e.entity_id === mine.id)).toBe(true);
  });

  it('events feed resolves entity_name for readable activity', async () => {
    const { recordEventTx } = await import('../src/lib/events');
    db.transaction((tx: any) =>
      recordEventTx(tx, 'item.filed', 'item', shared.id, { area_id: area.id }, owner.userId),
    );
    db.transaction((tx: any) =>
      recordEventTx(tx, 'area.created', 'area', area.id, {}, owner.userId),
    );
    const feed = (await get('/api/events?limit=100', owner)).json().events;
    const itemEv = feed.find((e: any) => e.entity_id === shared.id);
    const areaEv = feed.find((e: any) => e.entity_id === area.id && e.type === 'area.created');
    expect(itemEv.entity_name).toBe('shared-drill');
    expect(areaEv.entity_name).toBe('garage');
    // Private-item events still never surface to another member.
    const othersFeed = (await get('/api/events?limit=100', other)).json().events;
    expect(othersFeed.every((e: any) => e.entity_name !== 'mine-passport')).toBe(true);
  });
});

describe('digest webhook POST', () => {
  it('sends shared items only to the configured webhook', async () => {
    const http = await import('node:http');
    let posted: any = null;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { posted = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(200); res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    try {
      const { setDigestConfig, sendDigest } = await import('../src/lib/digest');
      await setDigestConfig({ enabled: true, webhook_url: `http://127.0.0.1:${port}/hook`, time: '09:00', base_url: 'http://x' });
      // Seed one shared out item next to the private 'mine-passport'.
      await db.update(schema.items).set({ status: 'out', outSince: new Date() }).where(eq(schema.items.id, shared.id));
      await sendDigest();
      expect(posted).toBeTruthy();
      const names = posted.items.map((i: any) => i.name);
      expect(names).toContain('shared-drill');
      expect(names).not.toContain('mine-passport');
      expect(names).not.toContain('theirs-diary');
      expect(posted.low_stock.map((i: any) => i.name)).not.toContain('mine-passport');
      expect(posted.warranty_expiring.map((i: any) => i.name)).not.toContain('mine-passport');
    } finally {
      server.close();
    }
  });
});

describe('signed photo URLs', () => {
  let photoName: string;
  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const dir = path.join(process.env.DATA_DIR!, 'photos');
    await fs.mkdir(dir, { recursive: true });
    photoName = 'sigtest.webp';
    await fs.writeFile(path.join(dir, photoName), Buffer.from('fake'));
    await db.insert(schema.photos).values({ itemId: mine.id, path: photoName, thumbPath: photoName });
  });

  it('a valid signature serves without a session (bearer capability)', async () => {
    const signed = signPhotoUrl(`/photos/${photoName}`);
    const res = await get(signed);
    expect(res.statusCode).toBe(200);
  });

  it('expired, tampered, and cross-path signatures are rejected', async () => {
    const signed = signPhotoUrl(`/photos/${photoName}`);
    const [p, qs] = signed.split('?');
    const params = new URLSearchParams(qs);
    const exp = params.get('exp')!;
    const sig = params.get('sig')!;

    // Expired.
    expect((await get(`${p}?exp=1&sig=${sig}`)).statusCode).toBe(401);
    // Tampered signature.
    expect((await get(`${p}?exp=${exp}&sig=${sig.slice(0, -2)}aa`)).statusCode).toBe(401);
    // Signature replayed against a different path.
    expect((await get(`/photos/nope.webp?exp=${exp}&sig=${sig}`)).statusCode).toBe(401);
    // Missing pieces.
    expect((await get(`${p}?exp=${exp}`)).statusCode).toBe(401);
  });
});
