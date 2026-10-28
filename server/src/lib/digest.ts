import crypto from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql as dsql } from 'drizzle-orm';
import { db } from '../db';
import { items, settings } from '../db/schema';
import { breadcrumb } from './breadcrumb';
import { thumbsForItems, thumbUrl } from './photos';
import { signPhotoUrl } from './signed';

/**
 * Missing/out items + the optional bundled digest.
 * "out"/"lent" = deliberately away, expected back.
 * "unaccounted" = reported not-here, or out for so long it's effectively lost
 * (30+ days). The digest is one bundled listing, never per-item pings.
 */

const UNACCOUNTED_AGE_DAYS = 30;

export interface DigestConfig {
  enabled: boolean;
  webhook_url: string;
  /** "HH:MM" in the container's TZ (set TZ env var). */
  time: string;
  /** Optional public base URL so digest photo links are absolute. */
  base_url: string;
}

export async function getDigestConfig(): Promise<DigestConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'digest'));
  const v = (row?.value ?? {}) as Partial<DigestConfig>;
  return {
    enabled: !!v.enabled,
    webhook_url: v.webhook_url ?? '',
    time: v.time ?? '09:00',
    base_url: v.base_url ?? '',
  };
}

export async function setDigestConfig(cfg: DigestConfig): Promise<void> {
  await db
    .insert(settings)
    .values({ key: 'digest', value: cfg as any })
    .onConflictDoUpdate({ target: settings.key, set: { value: cfg as any } });
}

/** Shared webhook token for HA/sensor/digest-trigger endpoints. */
export async function webhookToken(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'webhook_token'));
  if (row?.value) return row.value as string;
  const token = crypto.randomBytes(24).toString('base64url');
  await db
    .insert(settings)
    .values({ key: 'webhook_token', value: token })
    .onConflictDoNothing();
  return token;
}

const ageCutoff = () => new Date(Date.now() - UNACCOUNTED_AGE_DAYS * 86400_000);

export const daysOut = (since: Date | null) =>
  since ? Math.max(0, Math.floor((Date.now() - since.getTime()) / 86400_000)) : 0;

export interface OutRow {
  id: string;
  name: string | null;
  areaId: string;
  status: string;
  lentTo: string | null;
  outSince: Date | null;
  isPrivate: boolean;
  ownerId: string | null;
  remindSnoozedUntil: Date | null;
}

/** Everything not currently in its home, split by state. */
export async function fetchMissing(userId: string | null = null) {
  const visible = userId
    ? or(eq(items.isPrivate, false), eq(items.ownerId, userId))!
    : eq(items.isPrivate, false);
  const rows = await db
    .select()
    .from(items)
    .where(
      and(
        isNull(items.hiddenAt),
        visible,
        inArray(items.status, ['out', 'lent', 'unaccounted']),
      ),
    )
    .orderBy(asc(items.outSince));

  const cutoff = ageCutoff();
  const out: OutRow[] = [];
  const unaccounted: OutRow[] = [];
  for (const i of rows) {
    const isUnaccounted =
      i.status === 'unaccounted' || (i.outSince && i.outSince < cutoff && i.status !== 'home');
    (isUnaccounted ? unaccounted : out).push(i as unknown as OutRow);
  }
  return { out, unaccounted };
}

// Breadcrumb lookups are cached per call only - a module-level cache would
// go stale on renames/moves and grow forever.
type PathCache = Map<string, string>;
async function areaPath(areaId: string, cache: PathCache): Promise<string> {
  if (!cache.has(areaId)) {
    const c = await breadcrumb(areaId);
    cache.set(areaId, c.map((x) => x.name ?? '?').join(' › '));
  }
  return cache.get(areaId)!;
}

export async function outJson(rows: OutRow[]) {
  const thumbs = await thumbsForItems(rows.map((r) => r.id));
  const paths: PathCache = new Map();
  return Promise.all(
    rows.map(async (r) => {
      const t = thumbs.get(r.id);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        lent_to: r.lentTo,
        out_since: r.outSince,
        days: daysOut(r.outSince),
        area_id: r.areaId,
        area_path: await areaPath(r.areaId, paths),
        snoozed: !!(r.remindSnoozedUntil && r.remindSnoozedUntil > new Date()),
        thumb: t ? thumbUrl(t) : null,
      };
    }),
  );
}

const visibleTo = (userId: string | null) =>
  userId
    ? or(eq(items.isPrivate, false), eq(items.ownerId, userId))!
    : eq(items.isPrivate, false);

/** Consumables at or under their restock threshold. */
export async function fetchLowStock(userId: string | null = null) {
  return db
    .select()
    .from(items)
    .where(
      and(
        isNull(items.hiddenAt),
        visibleTo(userId),
        isNotNull(items.restockBelow),
        lte(items.quantity, items.restockBelow),
      ),
    );
}

/** Items whose warranty ends within `days` days (inclusive of today). */
export async function fetchWarrantyExpiring(userId: string | null = null, days = 30) {
  return db
    .select()
    .from(items)
    .where(
      and(
        isNull(items.hiddenAt),
        visibleTo(userId),
        isNotNull(items.warrantyUntil),
        dsql`warranty_until >= date('now') AND warranty_until <= date('now', '+' || ${days} || ' days')`,
      ),
    );
}

/** One bundled digest POST - shared items only, snoozed items skipped. */
export async function sendDigest(): Promise<{ sent: boolean; count: number }> {
  const cfg = await getDigestConfig();
  const { out, unaccounted } = await fetchMissing(null);
  const list = [...out, ...unaccounted].filter(
    (r) => !r.remindSnoozedUntil || r.remindSnoozedUntil < new Date(),
  );
  const low = await fetchLowStock(null);
  const warranties = await fetchWarrantyExpiring(null);
  if (!cfg.enabled || !cfg.webhook_url || (!list.length && !low.length && !warranties.length)) {
    return { sent: false, count: list.length };
  }
  const thumbs = await thumbsForItems(list.map((r) => r.id));
  const paths: PathCache = new Map();
  const base = cfg.base_url.replace(/\/$/, '');
  const payload = {
    text:
      `${list.length} thing(s) still out of their spot` +
      (low.length ? `, ${low.length} running low` : '') +
      (warranties.length ? `, ${warranties.length} warranty(ies) ending` : ''),
    count: list.length,
    items: await Promise.all(
      list.map(async (r) => ({
        id: r.id,
        name: r.name,
        path: await areaPath(r.areaId, paths),
        out_since: r.outSince,
        days: daysOut(r.outSince),
        status: r.status === 'unaccounted' ? 'unaccounted' : 'out',
        // Signed + expiring: ntfy/Discord fetch images without a session.
        photo: (t => t ? `${base}${signPhotoUrl(thumbUrl(t))}` : null)(thumbs.get(r.id)),
      })),
    ),
    low_stock: await Promise.all(
      low.map(async (i) => ({
        name: i.name,
        quantity: i.quantity,
        restock_below: i.restockBelow,
        path: await areaPath(i.areaId, paths),
      })),
    ),
    warranty_expiring: warranties.map((i) => ({
      name: i.name,
      warranty_until: i.warrantyUntil,
    })),
  };
  const res = await fetch(cfg.webhook_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  return { sent: true, count: list.length };
}

/** Daily-at-a-time digest check. Call once at boot. */
export function startDigestScheduler(): void {
  setInterval(async () => {
    try {
      const cfg = await getDigestConfig();
      if (!cfg.enabled || !cfg.webhook_url || !cfg.time) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (hhmm !== cfg.time) return;
      // Local date, not UTC - a toISOString() date can be "tomorrow" locally.
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const [row] = await db.select().from(settings).where(eq(settings.key, 'digest_last'));
      if (row?.value === today) return;
      const { sent } = await sendDigest();
      if (sent) {
        await db
          .insert(settings)
          .values({ key: 'digest_last', value: today })
          .onConflictDoUpdate({ target: settings.key, set: { value: today } });
      }
    } catch (e) {
      console.error('[digest] tick failed:', (e as Error).message);
    }
  }, 30_000);
}

export async function verifyWebhookToken(token: string | undefined): Promise<boolean> {
  const expected = await webhookToken();
  if (!token || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
