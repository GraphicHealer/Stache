import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db, sql } from '../db';
import { items } from '../db/schema';
import { env } from '../env';

/**
 * In-process CLIP (ViT-B/32) via transformers.js + onnxruntime-node.
 * Models download once into DATA_DIR/models (~350MB) — the /data volume.
 */
const MODEL = 'Xenova/clip-vit-base-patch32';

type Clip = {
  processor: any;
  tokenizer: any;
  vision: any;
  textModel: any;
};

let clipPromise: Promise<Clip> | null = null;
let clipReady = false;
let clipFailed = false;

function l2norm(v: ArrayLike<number>): number[] {
  const arr = Array.from(v);
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
  return arr.map((x) => x / norm);
}

async function loadClip(): Promise<Clip> {
  const hf = await import('@huggingface/transformers');
  hf.env.cacheDir = path.join(env.dataDir, 'models');
  const [processor, tokenizer, vision, textModel] = await Promise.all([
    hf.AutoProcessor.from_pretrained(MODEL),
    hf.AutoTokenizer.from_pretrained(MODEL),
    hf.CLIPVisionModelWithProjection.from_pretrained(MODEL),
    hf.CLIPTextModelWithProjection.from_pretrained(MODEL),
  ]);
  return { processor, tokenizer, vision, textModel };
}

function ensureClip(): Promise<Clip> {
  if (!clipPromise) {
    clipPromise = loadClip()
      .then((c) => {
        clipReady = true;
        return c;
      })
      .catch((e) => {
        clipFailed = true;
        clipPromise = null;
        throw e;
      });
  }
  return clipPromise;
}

/** Warm the cache at boot — first photo shouldn't wait on a download. */
export function preloadClip(): void {
  ensureClip().catch((e) => console.error('[ml] CLIP load failed:', e.message));
}

/** True once models are loaded. Embeddings features degrade quietly until then. */
export function mlHealthy(): boolean {
  return clipReady && !clipFailed;
}

export async function embedImage(buf: Buffer): Promise<number[]> {
  const hf = await import('@huggingface/transformers');
  const clip = await ensureClip();
  const { data, info } = await sharp(buf)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = new hf.RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
  const inputs = await clip.processor(image);
  const { image_embeds } = await clip.vision(inputs);
  return l2norm(image_embeds.data as Float32Array);
}

export async function embedText(text: string): Promise<number[]> {
  const clip = await ensureClip();
  const inputs = clip.tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await clip.textModel(inputs);
  return l2norm(text_embeds.data as Float32Array);
}

/** CLIP-embeds an item's photo and stores the vector on the item. */
export async function analyzeItemPhoto(itemId: string, photoPath: string): Promise<void> {
  const buf = await fs.readFile(path.join(env.dataDir, 'photos', photoPath));
  const embedding = await embedImage(buf);
  await db.update(items).set({ embedding }).where(eq(items.id, itemId));
}

const vecLiteral = (v: number[]) => `[${v.join(',')}]`;

/** `viewerId` null → shared items only (e.g. MCP); a user id → shared + their private. */
export async function nearestByVector(vec: number[], limit = 25, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return sql<{ id: string; dist: number }[]>`
    SELECT id, embedding <=> ${vecLiteral(vec)}::vector AS dist
    FROM items
    WHERE embedding IS NOT NULL AND hidden_at IS NULL
      AND (is_private = false OR owner_id = ${viewerId})
    ORDER BY embedding <=> ${vecLiteral(vec)}::vector
    LIMIT ${limit}`;
}

export async function nearestToItem(itemId: string, limit = 12, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return sql<{ id: string; dist: number }[]>`
    SELECT i.id, i.embedding <=> (SELECT embedding FROM items WHERE id = ${itemId}) AS dist
    FROM items i
    WHERE i.embedding IS NOT NULL AND i.hidden_at IS NULL AND i.id <> ${itemId}
      AND (i.is_private = false OR i.owner_id = ${viewerId})
    ORDER BY dist
    LIMIT ${limit}`;
}
