import { promises as fs } from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { items, photos, settings } from '../db/schema';
import { env } from '../env';
import { lookupBarcode, type DetectedCode } from './barcodes';

export interface AiConfig {
  enabled: boolean;
  base_url: string; // OpenAI-compatible, e.g. http://ollama:11434/v1
  model: string;
  api_key?: string;
}

export async function getAiConfig(): Promise<AiConfig | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'ai'));
  if (!row) return null;
  return row.value as unknown as AiConfig;
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

async function suggestOne(itemId: string): Promise<void> {
  const cfg = await getAiConfig();
  if (!cfg?.enabled) return;

  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) return;
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
  const dataUrl = `data:image/webp;base64,${(await fs.readFile(file)).toString('base64')}`;

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
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: userContent,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI provider ${res.status}: ${await res.text()}`);

  const body: any = await res.json();
  const content: string = body.choices?.[0]?.message?.content ?? '';
  const jsonText = content.replace(/```(?:json)?/g, '').trim();
  const parsed = JSON.parse(jsonText.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
    name?: string | null;
    description?: string | null;
    tags?: string[];
    ocr_text?: string | null;
  };

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
    if (next) await suggestOne(next.id);
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
