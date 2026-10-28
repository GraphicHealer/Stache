import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from './env';
import { getAuth, handleAuthRequest, sessionUser, userCount } from './auth';
import { user } from './db/schema';
import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { verifyPhotoSig } from './lib/signed';
import { parseBody } from './lib/validate';
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});
import { areaRoutes } from './routes/areas';
import { itemRoutes } from './routes/items';
import { labelRoutes } from './routes/labels';
import { searchRoutes } from './routes/search';
import { miscRoutes } from './routes/events';
import { printerRoutes } from './routes/printers';
import { settingsRoutes } from './routes/settings';
import { outRoutes } from './routes/out';
import { registerMcp } from './mcp';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: env.isProd ? 'info' : 'debug',
      serializers: {
        // Webhook tokens travel as ?token= - keep them out of the logs.
        req: (req) => ({
          method: req.method,
          url: (req.url ?? '').replace(/([?&]token=)[^&]+/g, '$1<redacted>'),
          host: req.headers?.host,
          remoteAddress: req.ip,
        }),
      },
    },
    bodyLimit: 30 * 1024 * 1024,
    // Deliberate: X-Forwarded-* is only trusted behind a configured proxy.
    trustProxy: env.trustProxy,
  });

  app.register(helmet, {
    // The SPA needs inline styles/scripts-free output; CSP off keeps camera +
    // blob: photo pipelines working, the rest of helmet's defaults apply.
    contentSecurityPolicy: false,
  });
  app.register(sensible);
  if (!env.isProd) app.register(cors, { origin: true });
  app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 8 },
  });

  // Built PWA, served at / with SPA fallback.
  const clientReady = existsSync(env.clientDist);
  if (clientReady) {
    app.register(fastifyStatic, { root: env.clientDist, index: ['index.html'] });
  }

  // Photo storage (separate mount so it can't clash with the SPA wildcard).
  // UUID filenames never change - long private cache, no shared-proxy cache.
  app.register(fastifyStatic, {
    root: path.join(env.dataDir, 'photos'),
    prefix: '/photos/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    },
  });

  app.get('/api/health', async () => ({ ok: true, version: env.appVersion }));

  // Better Auth handles everything under /api/auth/*.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: handleAuthRequest,
  });

  // Public: is first-run setup needed? Drives the login page's mode.
  app.get('/api/setup', async () => ({
    needs_setup: (await userCount()) === 0,
    needs_setup_token: !!env.setupToken,
  }));

  // Everything else under /api and /photos requires a session. MCP keeps its
  // own per-connection bearer auth; the SPA/static files stay public.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    // Signed photo URLs (digests, HA cards) carry their own HMAC - no session.
    if (url.startsWith('/photos/')) {
      const q = new URL(url, 'http://x').searchParams;
      const pathOnly = url.split('?')[0];
      if (verifyPhotoSig(pathOnly, q.get('exp') ?? undefined, q.get('sig') ?? undefined)) return;
    }
    const protectedPath = url.startsWith('/api') || url.startsWith('/photos');
    // Static assets don't need a session lookup at all.
    if (!protectedPath) return;
    const open =
      url === '/api/health' ||
      url === '/api/setup' ||
      url.startsWith('/api/auth') ||
      url.startsWith('/api/webhooks/');
    if (open) {
      req.user = await sessionUser(req).catch(() => null);
      return;
    }
    const user = await sessionUser(req).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
  });

  app.get('/api/me', async (req) => ({ user: req.user }));

  // First account is the admin: member management + settings are admin-only.
  const isAdmin = (req: { user: { role: string } | null }) => req.user?.role === 'admin';

  app.get('/api/users', async () => ({
    users: (await db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role })
      .from(user)
      .orderBy(asc(user.createdAt))),
  }));

  app.post('/api/users', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const parsed = parseBody(CreateUserSchema, req.body, reply);
    if (!parsed) return;
    const { name, email, password } = parsed;
    try {
      const res = await getAuth().api.signUpEmail({
        body: { name: name.trim(), email: email.trim(), password },
      });
      return reply.code(201).send({ user: { id: res.user.id, name: res.user.name, email: res.user.email } });
    } catch (e: any) {
      return reply.badRequest(e?.body?.message ?? e?.message ?? 'could not create user');
    }
  });

  // Remove a member (admin only; not yourself, not another admin). Their
  // private items lose their owner and become visible to nobody - the UI
  // warns about this.
  app.delete('/api/users/:id', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const { id } = req.params as { id: string };
    if (id === req.user?.id) return reply.badRequest("can't remove yourself");
    const [target] = await db.select({ role: user.role }).from(user).where(eq(user.id, id));
    if (!target) return reply.notFound();
    if (target.role === 'admin') return reply.badRequest("can't remove an admin");
    await db.delete(user).where(eq(user.id, id));
    return { ok: true };
  });

  app.register(areaRoutes);
  app.register(itemRoutes);
  app.register(labelRoutes);
  app.register(searchRoutes);
  app.register(miscRoutes);
  app.register(printerRoutes);
  app.register(settingsRoutes);
  app.register(outRoutes);
  registerMcp(app);

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (
      req.method === 'GET' &&
      clientReady &&
      !url.startsWith('/api') &&
      !url.startsWith('/photos')
    ) {
      return reply.sendFile('index.html');
    }
    return reply.notFound();
  });

  return app;
}
