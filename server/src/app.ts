import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from './env';
import { getAuth, handleAuthRequest, sessionUser, userCount } from './auth';
import { user } from './db/schema';
import { asc } from 'drizzle-orm';
import { db } from './db';
import { areaRoutes } from './routes/areas';
import { itemRoutes } from './routes/items';
import { labelRoutes } from './routes/labels';
import { searchRoutes } from './routes/search';
import { miscRoutes } from './routes/events';
import { printerRoutes } from './routes/printers';
import { settingsRoutes } from './routes/settings';
import { registerMcp } from './mcp';

export function buildApp() {
  const app = Fastify({
    logger: { level: env.isProd ? 'info' : 'debug' },
    bodyLimit: 30 * 1024 * 1024,
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
  app.register(fastifyStatic, {
    root: path.join(env.dataDir, 'photos'),
    prefix: '/photos/',
    decorateReply: false,
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Better Auth handles everything under /api/auth/*.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: handleAuthRequest,
  });

  // Public: is first-run setup needed? Drives the login page's mode.
  app.get('/api/setup', async () => ({ needs_setup: (await userCount()) === 0 }));

  // Everything else under /api and /photos requires a session. MCP keeps its
  // own per-connection bearer auth; the SPA/static files stay public.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    const protectedPath = url.startsWith('/api') || url.startsWith('/photos');
    const open =
      url === '/api/health' ||
      url === '/api/setup' ||
      url.startsWith('/api/auth') ||
      url.startsWith('/mcp');
    if (!protectedPath || open) {
      req.user = await sessionUser(req).catch(() => null);
      return;
    }
    const user = await sessionUser(req).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
  });

  app.get('/api/me', async (req) => ({ user: req.user }));

  // Household members (any logged-in user can add people).
  app.get('/api/users', async () => ({
    users: (await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .orderBy(asc(user.createdAt))),
  }));

  app.post('/api/users', async (req, reply) => {
    const { name, email, password } = (req.body ?? {}) as Record<string, string>;
    if (!name?.trim() || !email?.includes('@') || (password?.length ?? 0) < 8) {
      return reply.badRequest('name, a valid email, and an 8+ char password are required');
    }
    try {
      const res = await getAuth().api.signUpEmail({
        body: { name: name.trim(), email: email.trim(), password },
      });
      return reply.code(201).send({ user: { id: res.user.id, name: res.user.name, email: res.user.email } });
    } catch (e: any) {
      return reply.badRequest(e?.body?.message ?? e?.message ?? 'could not create user');
    }
  });

  app.register(areaRoutes);
  app.register(itemRoutes);
  app.register(labelRoutes);
  app.register(searchRoutes);
  app.register(miscRoutes);
  app.register(printerRoutes);
  app.register(settingsRoutes);
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
