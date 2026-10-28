import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { db, queryOne } from './db';
import { settings, user } from './db/schema';
import { env } from './env';

/**
 * Authentication via Better Auth (email+password, secure session cookies).
 * Mounted at /api/auth/*; first-run signup is open (optionally gated by
 * STACHE_SETUP_TOKEN), after that only a logged-in member can create accounts.
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function makeAuth(secret: string) {
  return betterAuth({
    appName: 'Stache',
    secret,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    ...(env.baseUrl ? { baseURL: env.baseUrl } : {}),
    ...(env.trustedOrigins.length ? { trustedOrigins: env.trustedOrigins } : {}),
    // Keep the session token signed in the cookie so static/photo hits don't
    // need a DB lookup when the cache window is fresh.
    session: { cookieCache: { enabled: true, maxAge: 300 } },
  });
}

type Auth = ReturnType<typeof makeAuth>;
let auth: Auth;
let secret_: string;

/** Used to sign photo URLs (signed.ts) - same persistence as sessions. */
export function authSecret(): string {
  return secret_;
}

/** Called once at boot, after migrations (the auth tables must exist). */
export async function initAuth(): Promise<void> {
  // Secret: env override, else generated once and persisted so restarts
  // don't invalidate sessions.
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'auth_secret'));
    if (row?.value) {
      secret = row.value as string;
    } else {
      secret = crypto.randomBytes(32).toString('hex');
      await db
        .insert(settings)
        .values({ key: 'auth_secret', value: secret })
        .onConflictDoNothing();
    }
  }
  secret_ = secret;
  auth = makeAuth(secret);
}

export function getAuth() {
  return auth;
}

export async function userCount(): Promise<number> {
  return queryOne<{ n: number }>(`SELECT count(*) AS n FROM user`)?.n ?? 0;
}

function headersOf(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) h.set(k, Array.isArray(v) ? v.join(' ') : String(v));
  }
  return h;
}

/** Current session user, or null. `role` is our column, not Better Auth's -
 * one indexed lookup per request. */
export async function sessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: headersOf(req) }).catch(() => null);
  const u = s?.user;
  if (!u) return null;
  const row = queryOne<{ role: string }>(`SELECT role FROM user WHERE id = ?`, u.id);
  return { id: u.id, name: u.name, email: u.email, role: row?.role ?? 'member' };
}

// First-run sign-up is the one place a fresh instance can be claimed. A
// process-wide promise serializes the count-check + create pair so two
// concurrent sign-ups can't both slip through as "first user".
let signupChain: Promise<unknown> = Promise.resolve();

/** Bridge Fastify <-> Better Auth's web-standard handler. */
export async function handleAuthRequest(req: FastifyRequest, reply: FastifyReply) {
  const url = new URL(req.raw.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Sign-up gating: first account is open (initial setup, optionally gated by
  // STACHE_SETUP_TOKEN); after that creating accounts requires a session.
  if (url.pathname.includes('/sign-up')) {
    const count = await userCount();
    if (count === 0) {
      // First signup is serialized via signupChain - recheck inside.
      const pending: Promise<{ denied: string } | { res: Response }> = signupChain.then(
        async () => {
        if (env.setupToken) {
          const provided =
            (req.body as any)?.setup_token ?? req.headers['x-setup-token'];
          if (
            typeof provided !== 'string' ||
            provided.length !== env.setupToken.length ||
            !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(env.setupToken))
          ) {
            return { denied: 'setup token required' };
          }
        }
        if ((await userCount()) === 0) {
          const res = await auth.handler(new Request(url.toString(), authInit(req)));
          if (res.ok) {
            // First account becomes the household admin.
            const first = queryOne<{ id: string }>(
              `SELECT id FROM user ORDER BY created_at LIMIT 1`,
            );
            if (first) {
              await db.update(user).set({ role: 'admin' }).where(eq(user.id, first.id));
            }
          }
          return { res };
        }
        return { denied: 'sign-up is closed' };
        },
      );
      signupChain = pending;
      const result = await pending;
      if ('denied' in result) return reply.code(403).send({ error: result.denied });
      return sendAuthResponse(result.res!, reply);
    }
    const u = await sessionUser(req);
    if (!u) return reply.code(403).send({ error: 'sign-up is closed' });
  }

  const res = await auth.handler(new Request(url.toString(), authInit(req)));
  return sendAuthResponse(res, reply);
}

function authInit(req: FastifyRequest): RequestInit {
  const headers = headersOf(req);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(req.body);
  }
  return init;
}

async function sendAuthResponse(res: Response, reply: FastifyReply) {
  reply.code(res.status);
  const cookies = res.headers.getSetCookie?.() ?? [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'set-cookie') reply.header(k, v);
  });
  for (const c of cookies) reply.header('set-cookie', c);
  const body = res.body ? Buffer.from(await res.arrayBuffer()) : null;
  return reply.send(body);
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}
