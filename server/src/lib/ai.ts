import { promises as fs } from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { items, photos, settings } from '../db/schema';
import { env } from '../env';
import { lookupBarcode, type DetectedCode } from './barcodes';
import { mlDisabled, vlmGenerate } from './ml';

export interface AiConfig {
  enabled: boolean;
  /** 'local' = built-in Florence-2; 'remote' = OpenAI-compatible endpoint. */
  provider?: 'local' | 'remote';
  base_url: string; // OpenAI-compatible, e.g. http://ollama:11434/v1
  model: string;
  api_key?: string;
}

export async function getAiConfig(): Promise<AiConfig | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'ai'));
  if (row) return row.value as unknown as AiConfig;
  // Out of the box the built-in Florence-2 suggests names - on-device, so
  // private items are covered too. STACHE_NO_ML disables it for tiny hosts;
  // any saved setting (including explicit "off") always wins.
  return { enabled: !mlDisabled, provider: 'local', base_url: '', model: '' };
}

export async function setAiConfig(cfg: AiConfig): Promise<void> {
  await db
    .insert(settings)
    .values({ key: 'ai', value: cfg as any })
    .onConflictDoUpdate({ target: settings.key, set: { value: cfg as any } });
}

/** Call on item creation - queues AI naming when a provider is configured. */
export async function maybeQueueItem(itemId: string): Promise<void> {
  const cfg = await getAiConfig();
  if (cfg?.enabled) {
    await db.update(items).set({ aiStatus: 'pending' }).where(eq(items.id, itemId));
  }
}

const PROMPT = `You catalog a single household object from a photo for a home inventory.
Reply with ONLY a JSON object:
{
  "name": string | null,        // short noun phrase a person would search for, or null if unsure
  "description": string | null, // one factual sentence (brand, model, color, condition)
  "tags": string[],             // search synonyms/words, e.g. ["power tool","cordless","driver"]
  "ocr_text": string | null     // text visible in the image: brands, model numbers, labels
}
Rules: never guess a name - null is better than wrong. No markdown, no explanation.`;

/** Shared VLM call - returns the raw text content. */
async function callVlm(cfg: AiConfig, system: string, userContent: any[]): Promise<string> {
  const res = await fetch(`${cfg.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`AI provider ${res.status}: ${(await res.text()).slice(0, 500)}`);
  // A hostile or garbage endpoint could return anything - cap the read.
  const raw = await res.text();
  if (raw.length > 2_000_000) throw new Error('AI response too large');
  const body: any = JSON.parse(raw);
  return body.choices?.[0]?.message?.content ?? '';
}

async function suggestOne(itemId: string): Promise<void> {
  const cfg = await getAiConfig();
  if (!cfg?.enabled) return;

  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) return;
  // Private items never leave the device - remote providers are skipped.
  if (item.isPrivate && cfg.provider !== 'local') {
    await db.update(items).set({ aiStatus: 'skipped' }).where(eq(items.id, itemId));
    return;
  }
  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.itemId, itemId))
    .orderBy(asc(photos.createdAt))
    .limit(1);
  if (!photo) {
    await db.update(items).set({ aiStatus: 'failed' }).where(eq(items.id, itemId));
    return;
  }

  const file = path.join(env.dataDir, 'photos', photo.path);
  const buf = await fs.readFile(file);

  let parsed: {
    name?: string | null;
    description?: string | null;
    tags?: string[];
    ocr_text?: string | null;
  } = {};

  if (cfg.provider === 'local') {
    const short = await vlmGenerate(buf, '<CAPTION>', 40);
    const detailed = await vlmGenerate(buf, '<MORE_DETAILED_CAPTION>', 100);
    const ocr = await vlmGenerate(buf, '<OCR>', 128).catch(() => null);
    const name = String(short.result?.['<CAPTION>'] ?? '').replace(/^(a|an|the)\s+/i, '').trim() || null;
    parsed = {
      name,
      description: String(detailed.result?.['<MORE_DETAILED_CAPTION>'] ?? '').trim() || null,
      tags: [],
      ocr_text: String(ocr?.result?.['<OCR>'] ?? '').trim() || null,
    };
  } else {
    const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;

    // Product context: confirmed barcode wins; detected-but-unconfirmed codes
    // are passed as hints only.
    const context: string[] = [];
    const codeToLookup = item.barcode ?? (item.detectedCodes as DetectedCode[] | null)?.[0]?.text;
    if (codeToLookup) {
      const product = await lookupBarcode(codeToLookup).catch(() => null);
      context.push(
        `Barcode ${codeToLookup} was seen on or with this item` +
          (product ? ` - it resolves to "${product.name}"${product.brand ? ` by ${product.brand}` : ''}` : '') +
          '.',
      );
    }
    if (item.name) context.push(`The owner called it "${item.name}".`);

    const userContent: any[] = [];
    if (context.length) userContent.push({ type: 'text', text: context.join(' ') });
    userContent.push({ type: 'image_url', image_url: { url: dataUrl } });

    const content = await callVlm(cfg, PROMPT, userContent);
    const jsonText = content.replace(/```(?:json)?/g, '').trim();
    parsed = JSON.parse(jsonText.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as typeof parsed;
  }

  // Suggest, never overwrite - user-entered fields always win.
  await db
    .update(items)
    .set({
      aiName: item.name ? null : parsed.name ?? null,
      aiDescription: item.description ? null : parsed.description ?? null,
      aiTags: Array.isArray(parsed.tags) ? parsed.tags : null,
      ocrText: item.ocrText ?? parsed.ocr_text ?? null,
      aiStatus: 'done',
    })
    .where(eq(items.id, itemId));
}

export interface DetectedObject {
  label: string;
  /** [ymin, xmin, ymax, xmax], normalized 0-1000. */
  box: [number, number, number, number];
}

const SPLIT_PROMPT = `You detect distinct physical objects in a photo of household stuff.
Reply with ONLY a JSON array:
[{"label": "short noun phrase", "box": [ymin, xmin, ymax, xmax]}]
Coordinates are normalized to 0-1000 relative to the image. List each separate
visible object once - hands, clothes, and background surfaces are not objects.
No markdown, no explanation.`;

/**
 * Find objects in a photo for the user to pick from. Suggestions only - nothing
 * here files anything; the split-confirm route does that on explicit picks.
 */
export async function detectObjects(photoFile: string, isPrivate = false): Promise<DetectedObject[]> {
  const cfg = await getAiConfig();
  if (!cfg?.enabled) throw new Error('AI provider is not configured');
  if (isPrivate && cfg.provider !== 'local')
    throw new Error('private items can only use the built-in model');
  const buf = await fs.readFile(photoFile);

  if (cfg.provider === 'local') {
    // Florence-2 <OD> returns pixel-space [x1,y1,x2,y2] boxes + real labels.
    const { result, size } = await vlmGenerate(buf, '<OD>', 256);
    const od = result?.['<OD>'] as { bboxes?: number[][]; labels?: string[] } | undefined;
    return (od?.bboxes ?? [])
      .map((b, i): DetectedObject => ({
        label: String(od?.labels?.[i] ?? 'object').slice(0, 120),
        box: [
          (b[1] / size.height) * 1000,
          (b[0] / size.width) * 1000,
          (b[3] / size.height) * 1000,
          (b[2] / size.width) * 1000,
        ],
      }))
      .filter((o) => o.box[2] - o.box[0] > 15 && o.box[3] - o.box[1] > 15)
      .slice(0, 12);
  }

  const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
  const content = await callVlm(cfg, SPLIT_PROMPT, [
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);
  const jsonText = content.replace(/```(?:json)?/g, '').trim();
  const parsed = JSON.parse(jsonText.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
  if (!Array.isArray(parsed)) return [];

  const raw = parsed
    .filter((o: any) => o?.label && Array.isArray(o.box ?? o.box_2d))
    .map((o: any) => ({
      label: String(o.label).slice(0, 120),
      box: ((o.box ?? o.box_2d) as unknown[]).map((v) => Number(v) || 0),
    }))
    .filter((o) => o.box.length === 4);
  // Some models emit 0-1 fractions despite the prompt - rescale those.
  const scale = raw.length && raw.every((o) => Math.max(...o.box) <= 1.5) ? 1000 : 1;
  return raw
    .map((o): DetectedObject => ({
      label: o.label,
      box: o.box.map((v) => Math.max(0, Math.min(1000, v * scale))) as DetectedObject['box'],
    }))
    .filter((o) => o.label && o.box[2] - o.box[0] > 15 && o.box[3] - o.box[1] > 15)
    .slice(0, 12);
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cfg = await getAiConfig();
    if (!cfg?.enabled) return;
    const [next] = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.aiStatus, 'pending'))
      .limit(1);
    if (next) {
      try {
        await suggestOne(next.id);
      } catch (e) {
        console.error('[ai] suggest failed:', (e as Error).message);
        await db
          .update(items)
          .set({ aiStatus: 'failed' })
          .where(eq(items.id, next.id))
          .catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

export function startAiWorker(): void {
  setInterval(() => tick().catch((e) => console.error('[ai]', e.message)), 10_000);
}

/** Kick immediately after an item is filed, so suggestions land fast. */
export function kickAi(): void {
  tick().catch((e) => console.error('[ai]', e.message));
}
