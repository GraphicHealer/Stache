import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-sync-'));

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

async function login(email: string) {
  const res: any = await getAuth().api.signUpEmail({
    body: { name: email.split('@')[0], email, password: 'password-123' },
    returnHeaders: true,
  });
  const headers: Headers = res?.headers ?? res?.response?.headers;
  return { cookie: (headers?.get('set-cookie') ?? '').split(';')[0], userId: res?.response?.user?.id ?? res?.user?.id };
}

let member: any, area: any;

beforeAll(async () => {
  member = await login('sync@t.dev');
  [area] = await db.insert(schema.areas).values({ name: 'bin' }).returning();
}, 60_000);

const file = (headers: any, body: any) =>
  app.inject({ method: 'POST', url: '/api/items', headers, payload: body });

describe('offline replay idempotency (client_id)', () => {
  it('a replayed client_id returns the original item, not a duplicate', async () => {
    const cid = 'c-' + crypto.randomUUID();
    const first = await file(member, { area_id: area.id, name: 'lamp', client_id: cid });
    expect(first.statusCode).toBe(201);
    const replay = await file(member, { area_id: area.id, name: 'lamp', client_id: cid });
    expect(replay.statusCode).toBe(200);
    const a = first.json().item, b = replay.json().item;
    expect(b.id).toBe(a.id);
    expect(replay.json().deduped).toBe(true);

    const rows = await db.select().from(schema.items).where(eq(schema.items.clientId, cid));
    expect(rows.length).toBe(1);
  });

  it('concurrent submissions with the same client_id produce one item', async () => {
    const cid = 'c-' + crypto.randomUUID();
    const [r1, r2, r3] = await Promise.all([
      file(member, { area_id: area.id, name: 'x', client_id: cid }),
      file(member, { area_id: area.id, name: 'x', client_id: cid }),
      file(member, { area_id: area.id, name: 'x', client_id: cid }),
    ]);
    const ids = [r1, r2, r3].map((r) => r.json().item.id);
    expect(new Set(ids).size).toBe(1);
    const rows = await db.select().from(schema.items).where(eq(schema.items.clientId, cid));
    expect(rows.length).toBe(1);
  });

  it('different client_ids still file distinct items', async () => {
    const a1 = await file(member, { area_id: area.id, name: 'a', client_id: 'c-a' });
    const a2 = await file(member, { area_id: area.id, name: 'b', client_id: 'c-b' });
    expect(a1.json().item.id).not.toBe(a2.json().item.id);
  });
});

describe('photo upload validation', () => {
  const boundary = 'X-BOUNDARY';
  const multipart = (filename: string, content: Buffer | string) => ({
    method: 'POST' as const,
    url: '/api/items',
    headers: { ...member, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="area_id"\r\n\r\n${area.id}\r\n` +
        `--${boundary}\r\ncontent-disposition: form-data; name="photo"; filename="${filename}"\r\ncontent-type: image/jpeg\r\n\r\n`,
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });

  it('rejects non-image content with a clean 400', async () => {
    const res = await app.inject(multipart('x.jpg', 'this is definitely not an image'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('image');
    // And nothing was filed for the bad upload.
    const n = await db.select({ id: schema.items.id }).from(schema.items)
      .where(eq(schema.items.name, null));
    expect(n.length).toBe(0);
  });

  it('accepts a real photo', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 12, height: 12, channels: 3, background: { r: 40, g: 120, b: 200 } },
    }).png().toBuffer();
    const res = await app.inject(multipart('ok.png', png));
    expect(res.statusCode).toBe(201);
    expect(res.json().item.id).toBeTruthy();
  });
});
