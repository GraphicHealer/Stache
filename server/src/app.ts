import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from './env';
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
