import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { db, sql } from './db';
import { settings } from './db/schema';

/**
 * Authentication via Better Auth (email+password, secure session cookies).
 * Mounted at /api/auth/*; first-run signup is open, after that only a
 * logged-in member can create accounts (household adds users in Settings).
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

function makeAuth(secret: string) {
  return betterAuth({
    appName: 'Stash',
    secret,
    database: drizzleAdapter(db, { provider: 'pg' }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
  });
}

type Auth = ReturnType<typeof makeAuth>;
let auth: Auth;

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
  auth = makeAuth(secret);
}

export function getAuth() {
  return auth;
}

export async function userCount(): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM "user"`;
  return n;
}

function headersOf(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) h.set(k, Array.isArray(v) ? v.join(' ') : String(v));
  }
  return h;
}

/** Current session user, or null. */
export async function sessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: headersOf(req) }).catch(() => null);
  const u = s?.user;
  return u ? { id: u.id, name: u.name, email: u.email } : null;
}

/** Bridge Fastify <-> Better Auth's web-standard handler. */
export async function handleAuthRequest(req: FastifyRequest, reply: FastifyReply) {
  const url = new URL(req.raw.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Sign-up gating: first account is open (initial setup); after that,
  // creating accounts requires an existing session (household members only).
  if (url.pathname.includes('/sign-up')) {
    const [count, user] = await Promise.all([userCount(), sessionUser(req)]);
    if (count > 0 && !user) return reply.code(403).send({ error: 'sign-up is closed' });
  }

  const headers = headersOf(req);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(req.body);
  }
  const res = await auth.handler(new Request(url.toString(), init));
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
