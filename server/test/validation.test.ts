import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'stache-valid-'));

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

const putAi = (headers: any, base_url: string) =>
  app.inject({
    method: 'PUT',
    url: '/api/settings/ai',
    headers,
    payload: { provider: 'remote', base_url },
  });

describe('ai base_url validation (SSRF surface)', () => {
  let admin: any;
  beforeAll(async () => {
    admin = await login('va@t.dev', 'admin');
  });

  it('allows local + LAN providers (the intended deployments)', async () => {
    for (const u of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
      'http://192.168.1.50:11434',
      'http://10.0.0.5:8080/v1',
      'http://100.64.1.2:11434/v1', // tailnet/CGNAT range is legit
      'http://ollama:11434/v1',     // unresolvable name -> allowed, fails at fetch
      'https://api.openai.com/v1',
    ]) {
      const res = await putAi(admin, u);
      expect(res.statusCode, u).toBe(200);
    }
  });

  it('rejects metadata + link-local targets in every spelling', async () => {
    for (const u of [
      'http://169.254.169.254/',            // AWS/GCP/Azure metadata
      'http://169.254.170.2/',              // ECS task metadata
      'http://2852039166/',                 // decimal form of 169.254.169.254
      'http://0xa9fea9fe/',                 // hex form
      'http://0251.0376.0251.0376/',        // octal form
      'http://[fe80::a9fe:a9fe]/',          // AWS IPv6 metadata
      'http://[fd00:ec2::254]/',            // AWS IPv6 metadata (ULA)
      'http://[::ffff:a9fe:a9fe]/',         // IPv4-mapped IPv6 form
      'http://[64:ff9b::a9fe:a9fe]/',       // NAT64-wrapped form
      'http://100.100.100.200/',            // Alibaba metadata
      'http://metadata.google.internal/',
      'http://sub.metadata.google.internal/',
      'http://user:pass@169.254.169.254/',  // creds don't hide the host
    ]) {
      const res = await putAi(admin, u);
      expect(res.statusCode, u).toBe(400);
    }
  });

  it('rejects non-http schemes and malformed URLs', async () => {
    for (const u of [
      'ftp://example.com',
      'file:///etc/passwd',
      'gopher://169.254.169.254/',
      'not-a-url',
      'http://',
    ]) {
      const res = await putAi(admin, u);
      expect(res.statusCode, u).toBe(400);
    }
  });
});

describe('checkedLookup (connect-time DNS check)', () => {
  it('rejects when a name resolves to a prohibited address', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    const lookup = checkedLookup(() => Promise.resolve({ address: '169.254.169.254', family: 4 }));
    const err: any = await new Promise((res) => lookup('evil.lan', {}, (e) => res(e)));
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('prohibited');
  });

  it('rejects an IPv6 link-local answer too', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    const lookup = checkedLookup(() => Promise.resolve({ address: 'fe80::a9fe:a9fe', family: 6 }));
    const err: any = await new Promise((res) => lookup('v6.lan', {}, (e) => res(e)));
    expect(err).toBeInstanceOf(Error);
  });

  it('allows ordinary LAN/loopback answers', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    for (const a of [
      { address: '192.168.1.50', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: 'fd00::1', family: 6 },
    ]) {
      const lookup = checkedLookup(() => Promise.resolve(a));
      const got: any = await new Promise((res, rej) =>
        lookup('nas.lan', {}, (e, addr, fam) => (e ? rej(e) : res([addr, fam]))),
      );
      expect(got).toEqual([a.address, a.family]);
    }
  });

  it('blocks IPv4-mapped and NAT64-embedded metadata answers', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    for (const addr of ['::ffff:169.254.169.254', '64:ff9b::169.254.169.254', '64:ff9b::a9fe:a9fe']) {
      const lookup = checkedLookup(() => Promise.resolve({ address: addr, family: 6 }));
      const err: any = await new Promise((res) => lookup('h.lan', {}, (e) => res(e)));
      expect(err, addr).toBeInstanceOf(Error);
    }
  });

  it('blocks if ANY answer is prohibited - not just the first', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    const lookup = checkedLookup(() =>
      Promise.resolve([
        { address: '192.168.1.5', family: 4 },
        { address: 'fe80::a9fe:a9fe', family: 6 },
      ]),
    );
    const err: any = await new Promise((res) => lookup('two-faced.lan', {}, (e) => res(e)));
    expect(err).toBeInstanceOf(Error);
    // ...and a clean mixed v4+v6 answer set is fine.
    const ok = checkedLookup(() =>
      Promise.resolve([
        { address: '192.168.1.5', family: 4 },
        { address: 'fd00::5', family: 6 },
      ]),
    );
    const got: any = await new Promise((res, rej) =>
      ok('nas.lan', {}, (e, addr, fam) => (e ? rej(e) : res([addr, fam]))),
    );
    expect(got).toEqual(['192.168.1.5', 4]);
  });

  it('works through real dns.lookup with undici-style options', async () => {
    const { checkedLookup } = await import('../src/lib/urlcheck');
    // Literal IPs never hit DNS - lookup returns them verbatim, still checked.
    const blocked = checkedLookup();
    const err: any = await new Promise((res) =>
      blocked('169.254.169.254', { family: 0, hints: 0 }, (e) => res(e)),
    );
    expect(err).toBeInstanceOf(Error);
    const ok = checkedLookup();
    const got: any = await new Promise((res, rej) =>
      ok('127.0.0.1', { family: 0, hints: 0 }, (e, addr, fam) => (e ? rej(e) : res([addr, fam]))),
    );
    expect(got).toEqual(['127.0.0.1', 4]);
  });
});

describe('callVlm redirect handling', () => {
  it('a 302 from the configured endpoint is refused, not followed', async () => {
    const http = await import('node:http');
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(302, { location: 'http://169.254.169.254/latest' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    try {
      const { callVlm } = await import('../src/lib/ai');
      await expect(
        callVlm(
          { enabled: true, provider: 'remote', base_url: `http://127.0.0.1:${port}`, model: 'm', api_key: null } as any,
          'sys',
          [],
        ),
      ).rejects.toThrow(/redirect/i);
      // One request, to our stub only - never the redirect target.
      expect(hits).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /api/items/:id validation', () => {
  let member: any, item: any;
  beforeAll(async () => {
    member = await login('vp@t.dev');
    const [a] = await db.insert(schema.areas).values({ name: 'bin' }).returning();
    [item] = await db.insert(schema.items).values({ areaId: a.id, name: 'thing' }).returning();
  });

  const patch = (body: any) =>
    app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      headers: member,
      payload: body,
    });

  it('rejects malformed quantities', async () => {
    for (const q of ['abc', -3, 0, 1.5, true, 'three']) {
      expect((await patch({ quantity: q })).statusCode, String(q)).toBe(400);
    }
    expect((await patch({ quantity: '5' })).statusCode).toBe(200);
    expect((await patch({ quantity: 7 })).statusCode).toBe(200);
  });

  it('rejects malformed numbers for thresholds and prices', async () => {
    for (const v of ['abc', -1, true]) {
      expect((await patch({ restock_below: v })).statusCode, String(v)).toBe(400);
      expect((await patch({ purchase_price: v })).statusCode, String(v)).toBe(400);
    }
    // Null still clears intentionally.
    expect((await patch({ restock_below: null })).statusCode).toBe(200);
    expect((await patch({ purchase_price: null })).statusCode).toBe(200);
    expect((await patch({ restock_below: '3' })).statusCode).toBe(200);
  });

  it('rejects fake calendar dates but accepts real ones', async () => {
    for (const d of ['2026-13-01', '2026-02-30', 'not-a-date', '2026/01/15']) {
      expect((await patch({ purchase_date: d })).statusCode, d).toBe(400);
      expect((await patch({ warranty_until: d })).statusCode, d).toBe(400);
    }
    expect((await patch({ purchase_date: '2026-02-28' })).statusCode).toBe(200);
    // 2026 is not a leap year; 2028 is.
    expect((await patch({ warranty_until: '2026-02-29' })).statusCode).toBe(400);
    expect((await patch({ warranty_until: '2028-02-29' })).statusCode).toBe(200);
    expect((await patch({ warranty_until: null })).statusCode).toBe(200);
  });

  it('rejects invalid timestamps and unknown fields', async () => {
    expect((await patch({ remind_snoozed_until: 'later' })).statusCode).toBe(400);
    expect((await patch({ bogus_field: 1 })).statusCode).toBe(400);
    expect((await patch({ name: 'ok', sql_injection: 'drop' })).statusCode).toBe(400);
  });

  it('still accepts a normal partial update', async () => {
    const res = await patch({ name: 'drill', tags: ['power'], retailer: 'hardware store' });
    expect(res.statusCode).toBe(200);
    const { item: i } = res.json();
    expect(i.name).toBe('drill');
    expect(i.tags).toEqual(['power']);
    expect(i.retailer).toBe('hardware store');
  });
});
