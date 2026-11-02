import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { items, mcpTokens, settings } from '../db/schema';
import { getAiConfig, kickAi, setAiConfig } from '../lib/ai';
import { activeMlLevel, analyzeItemPhoto, invalidateMlLevel, vlmDownloaded, vlmStatus, warmVlm } from '../lib/ml';
import { getDigestConfig, setDigestConfig, webhookToken } from '../lib/digest';
import { getBackupSchedule, setBackupSchedule } from '../lib/backup';
import { requireAdmin } from '../lib/guards';
import { parseBody } from '../lib/validate';
import { z } from 'zod';

const AiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['local', 'remote']).optional(),
  base_url: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  api_key: z.string().max(500).nullable().optional(),
  ml_level: z.number().int().min(0).max(3).nullable().optional(),
}).passthrough();

const DigestSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  webhook_url: z.string().max(1000).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM').optional(),
  base_url: z.string().max(500).optional(),
}).passthrough();

// The AI endpoint is fetched server-side - validate it like an SSRF surface.
// LAN/loopback hosts are deliberately allowed (Ollama on the network or on
// localhost is the intended use); link-local/cloud-metadata targets and
// non-http schemes are refused. The URL parser normalizes decimal/hex/octal
// IPv4 and compresses IPv6 literals, so the checks below run on canonical
// forms.

/** Dotted-quad -> int32, or null. */
function parseV4(h: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** IPv6 literal (no brackets) -> 16 bytes, or null. Handles `::` and mixed
 *  `::ffff:a.b.c.d` spellings. */
function parseV6(h: string): number[] | null {
  let tailV4: number | null = null;
  if (h.includes('.')) {
    tailV4 = parseV4(h.slice(h.lastIndexOf(':') + 1));
    if (tailV4 === null) return null;
    h = h.slice(0, h.lastIndexOf(':')) + ':0:0';
  }
  if (h.split('::').length > 2) return null;
  const [left, right] = h.split('::');
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  if (l.length + r.length > 8 || (right === undefined && l.length !== 8)) return null;
  const groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tailV4 !== null) {
    bytes[12] = tailV4 >>> 24;
    bytes[13] = (tailV4 >>> 16) & 0xff;
    bytes[14] = (tailV4 >>> 8) & 0xff;
    bytes[15] = tailV4 & 0xff;
  }
  return bytes;
}

function blockedV4(v4: number): boolean {
  // 169.254.0.0/16 link-local: AWS/GCP/Azure/ECS metadata all live here.
  if (v4 >>> 16 === 0xa9fe) return true;
  // 100.100.100.200 - Alibaba metadata. (Not the whole /10: Tailscale is CGNAT.)
  return v4 === ((100 * 256 + 100) * 256 + 100) * 256 + 200;
}

/** Is a literal IP (v4 dotted quad or [v6]) a refused SSRF target? */
function badIpLiteral(host: string): boolean {
  const v4 = parseV4(host);
  if (v4 !== null) return blockedV4(v4);
  if (!host.startsWith('[')) return false;
  const bytes = parseV6(host.slice(1, -1));
  if (!bytes) return true; // unparseable literal - refuse rather than guess
  // IPv4-embedded forms (::ffff:x, NAT64 64:ff9b::x) - judge the inner v4.
  const embedded =
    (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0));
  if (embedded) {
    return blockedV4(((bytes[12] * 256 + bytes[13]) * 256 + bytes[14]) * 256 + bytes[15]);
  }
  // fe80::/10 IPv6 link-local (AWS v6 metadata is fe80::a9fe:a9fe).
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // fd00:ec2::/64 - AWS IPv6 metadata prefix.
  if (
    bytes[0] === 0xfd && bytes[1] === 0x00 && bytes[2] === 0x0e && bytes[3] === 0xc2 &&
    bytes.slice(4, 8).every((b) => b === 0)
  ) return true;
  return false;
}

async function badAiUrl(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'base_url must be a URL like http://ollama:11434/v1';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return 'base_url must be http or https';
  if (!u.hostname) return 'base_url needs a hostname';
  const h = u.hostname.toLowerCase();
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal'))
    return 'base_url points at a cloud metadata endpoint';
  if (badIpLiteral(h)) return 'base_url points at a link-local/metadata address';
  // A name can still point at a blocked address (nip.io magic domains, a
  // rebind). If it resolves, check every answer; a name that doesn't resolve
  // yet is allowed - the service may simply be down right now.
  if (parseV4(h) === null && !h.startsWith('[')) {
    try {
      for (const a of await dns.lookup(h, { all: true })) {
        if (badIpLiteral(a.family === 4 ? a.address : `[${a.address}]`))
          return 'base_url resolves to a link-local/metadata address';
      }
    } catch {
      /* unresolvable - the fetch will fail cleanly later */
    }
  }
  return null;
}

const BackupScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  interval_days: z.number().int().min(1).max(30).optional(),
  keep: z.number().int().min(1).max(30).optional(),
}).passthrough();

const McpCreateSchema = z.object({
  name: z.string().min(1).max(100),
  scope: z.enum(['read', 'read-write']).optional(),
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
      provider: cfg?.provider ?? 'local',
      local_ready: await vlmDownloaded(),
      ml_level: await activeMlLevel(),
      ml: vlmStatus(),
      base_url: cfg?.base_url ?? '',
      model: cfg?.model ?? '',
      has_api_key: !!cfg?.api_key,
    };
  });

  app.put('/api/settings/ai', async (req, reply) => {
    const body = parseBody(AiSettingsSchema, req.body, reply);
    if (!body) return;
    if (body.base_url) {
      const err = await badAiUrl(body.base_url);
      if (err) return reply.badRequest(err);
    }
    const prev = await getAiConfig();
    const cfg = {
      enabled: body.enabled ?? prev?.enabled ?? false,
      provider: (body.provider ?? prev?.provider) === 'local' ? ('local' as const) : ('remote' as const),
      base_url: body.base_url ?? prev?.base_url ?? '',
      model: body.model ?? prev?.model ?? '',
      api_key: body.api_key != null ? body.api_key : prev?.api_key,
    };
    if (body.enabled !== undefined || body.provider !== undefined || body.base_url !== undefined ||
        body.model !== undefined || body.api_key !== undefined) {
      await setAiConfig(cfg);
    }
    if (body.ml_level !== undefined) {
      if (body.ml_level === null) {
        await db.delete(settings).where(eq(settings.key, 'ml_level'));
      } else {
        await db
          .insert(settings)
          .values({ key: 'ml_level', value: { level: body.ml_level } as any })
          .onConflictDoUpdate({ target: settings.key, set: { value: { level: body.ml_level } as any } });
      }
      invalidateMlLevel();
      // New selection -> start fetching it now; the purge of the old model
      // only arms once the new one is ready.
      if (cfg.provider === 'local' && cfg.enabled) warmVlm();
    }
    kickAi();
    return { ok: true };
  });

  // Re-run suggestion for one item.
  app.post('/api/items/:id/ai-rerun', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
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
  app.post('/api/settings/backfill', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async () => {
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
    const { name, scope } = body;
    const token = crypto.randomBytes(24).toString('base64url');
    const [conn] = await db
      .insert(mcpTokens)
      .values({
        name: name.trim(),
        slug: crypto.randomBytes(9).toString('base64url'),
        token: null,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        scope: scope ?? 'read-write',
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

  // --- Scheduled backups ----------------------------------------------------
  // Opt-in: writes unencrypted bundles under /data/backups, keeps newest N.

  app.get('/api/settings/backup-schedule', async () => getBackupSchedule());

  app.put('/api/settings/backup-schedule', async (req, reply) => {
    const body = parseBody(BackupScheduleSchema, req.body, reply);
    if (!body) return;
    const prev = await getBackupSchedule();
    await setBackupSchedule({
      enabled: !!body.enabled,
      interval_days: body.interval_days ?? prev.interval_days,
      keep: body.keep ?? prev.keep,
    });
    return { ok: true };
  });
}
