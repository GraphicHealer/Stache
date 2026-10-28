import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { items, mcpTokens } from '../db/schema';
import { getAiConfig, kickAi, setAiConfig } from '../lib/ai';
import { analyzeItemPhoto, vlmDownloaded } from '../lib/ml';
import { getDigestConfig, setDigestConfig, webhookToken } from '../lib/digest';
import { requireAdmin } from '../lib/guards';
import { parseBody } from '../lib/validate';
import { z } from 'zod';

const AiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['local', 'remote']).optional(),
  base_url: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  api_key: z.string().max(500).nullable().optional(),
}).passthrough();

const DigestSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  webhook_url: z.string().max(1000).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM').optional(),
  base_url: z.string().max(500).optional(),
}).passthrough();

const McpCreateSchema = z.object({
  name: z.string().min(1).max(100),
}).passthrough();

export async function settingsRoutes(app: FastifyInstance) {
  // Everything under /api/settings exposes tokens or server-side fetch
  // targets - admin only.
  app.addHook('preHandler', requireAdmin);
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
    const body = parseBody(AiSettingsSchema, req.body, reply);
    if (!body) return;
    const prev = await getAiConfig();
    await setAiConfig({
      enabled: !!body.enabled,
      provider: body.provider === 'local' ? 'local' : 'remote',
      base_url: body.base_url ?? prev?.base_url ?? '',
      model: body.model ?? prev?.model ?? '',
      api_key: body.api_key != null ? body.api_key : prev?.api_key,
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

  // Backfill: items filed before AI/ML was switched on. Re-queues pending
  // suggestions for anything that never got one, and embeds every photo
  // missing a vector. Runs in the background - inference stays serialized.
  app.post('/api/settings/backfill', async () => {
    const cfg = await getAiConfig();
    const aiQueued = cfg?.enabled
      ? sqlite
          .prepare(
            `UPDATE items SET ai_status = 'pending'
             WHERE ai_status IS NULL AND hidden_at IS NULL
               AND EXISTS (SELECT 1 FROM photos WHERE photos.item_id = items.id)`,
          )
          .run().changes
      : 0;
    if (aiQueued) kickAi();

    const missing = sqlite
      .prepare(
        `SELECT p.id, p.item_id, p.path FROM photos p
         WHERE p.item_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.photo_id = p.id)`,
      )
      .all() as { id: string; item_id: string; path: string }[];
    let done = 0;
    const total = missing.length;
    (async () => {
      for (const p of missing) {
        try {
          await analyzeItemPhoto(p.item_id, p.id, p.path);
        } catch (e) {
          console.error('[ml] backfill failed for', p.id, (e as Error).message);
          break; // model missing/broken - no point hammering every photo
        }
        done++;
      }
    })();
    return { ok: true, ai_queued: aiQueued, embeddings_queued: total };
  });

  // --- MCP connections -----------------------------------------------------
  // Each external AI gets its own URL (/mcp/<slug>) - revocable independently.
  // Tokens are stored as SHA-256 hashes; the plaintext is returned once here.

  app.get('/api/settings/mcp', async () => ({
    connections: (await db.select().from(mcpTokens).orderBy(asc(mcpTokens.createdAt))).map(
      ({ token, tokenHash, ...c }) => c,
    ),
  }));

  app.post('/api/settings/mcp', async (req, reply) => {
    const body = parseBody(McpCreateSchema, req.body, reply);
    if (!body) return;
    const { name } = body;
    const token = crypto.randomBytes(24).toString('base64url');
    const [conn] = await db
      .insert(mcpTokens)
      .values({
        name: name.trim(),
        slug: crypto.randomBytes(9).toString('base64url'),
        token: null,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      })
      .returning();
    const { token: _t, tokenHash: _h, ...pub } = conn;
    return reply.code(201).send({ connection: pub, token });
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

  app.put('/api/settings/digest', async (req, reply) => {
    const body = parseBody(DigestSettingsSchema, req.body, reply);
    if (!body) return;
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
