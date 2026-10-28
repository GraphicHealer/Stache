import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { items, mcpTokens } from '../db/schema';
import { getAiConfig, kickAi, setAiConfig } from '../lib/ai';
import { vlmDownloaded } from '../lib/ml';
import { getDigestConfig, setDigestConfig, webhookToken } from '../lib/digest';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/ai', async () => {
    const cfg = await getAiConfig();
    return {
      configured: !!cfg,
      enabled: cfg?.enabled ?? false,
      provider: cfg?.provider ?? 'remote',
      local_ready: await vlmDownloaded(),
      base_url: cfg?.base_url ?? '',
      model: cfg?.model ?? '',
      has_api_key: !!cfg?.api_key,
    };
  });

  app.put('/api/settings/ai', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const prev = await getAiConfig();
    await setAiConfig({
      enabled: !!body.enabled,
      provider: body.provider === 'local' ? 'local' : 'remote',
      base_url: body.base_url ?? prev?.base_url ?? '',
      model: body.model ?? prev?.model ?? '',
      api_key: body.api_key !== undefined ? body.api_key : prev?.api_key,
    });
    kickAi();
    return { ok: true };
  });

  // Re-run suggestion for one item.
  app.post('/api/items/:id/ai-rerun', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.notFound();
    await db.update(items).set({ aiStatus: 'pending' }).where(eq(items.id, id));
    kickAi();
    return { ok: true };
  });

  // --- MCP connections -----------------------------------------------------
  // Each external AI gets its own URL (/mcp/<token>) - revocable independently.

  app.get('/api/settings/mcp', async () => ({
    connections: await db.select().from(mcpTokens).orderBy(asc(mcpTokens.createdAt)),
  }));

  app.post('/api/settings/mcp', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.badRequest('name is required');
    const [conn] = await db
      .insert(mcpTokens)
      .values({
        name: name.trim(),
        slug: crypto.randomBytes(9).toString('base64url'),
        token: crypto.randomBytes(24).toString('base64url'),
      })
      .returning();
    return reply.code(201).send({ connection: conn });
  });

  app.delete('/api/settings/mcp/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(mcpTokens).where(eq(mcpTokens.id, id));
    return { ok: true };
  });

  // --- Out reminders (bundled digest + HA webhooks) -------------------------

  app.get('/api/settings/digest', async () => {
    const cfg = await getDigestConfig();
    return { ...cfg, webhook_token: await webhookToken() };
  });

  app.put('/api/settings/digest', async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const prev = await getDigestConfig();
    await setDigestConfig({
      enabled: !!body.enabled,
      webhook_url: body.webhook_url ?? prev.webhook_url,
      time: body.time ?? prev.time,
      base_url: body.base_url ?? prev.base_url,
    });
    return { ok: true };
  });
}
