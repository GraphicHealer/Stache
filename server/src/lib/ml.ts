import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { query, queryOne, sqlite, placeholders } from '../db';
import { env } from '../env';

/**
 * In-process CLIP (ViT-B/32, q8) via transformers.js + onnxruntime-node.
 * Loads lazily on first embed - never at boot, so a cold start stays light.
 * Models download once into DATA_DIR/models (~350MB disk).
 * STASH_NO_ML=1 disables it entirely (very low-RAM hosts).
 */
const MODEL = 'Xenova/clip-vit-base-patch32';

// Keep inference polite: q8 weights (~4x smaller), few threads, no arena
// pre-allocation, basic graph opts. Prevents CPU/RAM spikes on small hosts.
const SESSION_OPTS = {
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  enableCpuMemArena: false,
  enableMemPattern: false,
  graphOptimizationLevel: 'basic' as const,
  logSeverityLevel: 3 as const,
};
const MODEL_OPTS = { dtype: 'q8' as const, session_options: SESSION_OPTS };

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

const mlDisabled = process.env.STASH_NO_ML === '1';

async function loadClip(): Promise<Clip> {
  if (mlDisabled) throw new Error('ML disabled via STASH_NO_ML');
  const hf = await import('@huggingface/transformers');
  hf.env.cacheDir = path.join(env.dataDir, 'models');
  const [processor, tokenizer, vision, textModel] = await Promise.all([
    hf.AutoProcessor.from_pretrained(MODEL),
    hf.AutoTokenizer.from_pretrained(MODEL),
    hf.CLIPVisionModelWithProjection.from_pretrained(MODEL, MODEL_OPTS),
    hf.CLIPTextModelWithProjection.from_pretrained(MODEL, MODEL_OPTS),
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

/**
 * True once models are loaded. Embeddings features degrade quietly until then.
 * Not a Promise - stays sync so callers can use it in `if` checks.
 */
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

/** CLIP-embeds an item's photo and stores the vector in the vec0 table. */
export async function analyzeItemPhoto(itemId: string, photoPath: string): Promise<void> {
  const buf = await fs.readFile(path.join(env.dataDir, 'photos', photoPath));
  const embedding = await embedImage(buf);
  sqlite
    .prepare('INSERT OR REPLACE INTO item_embeddings (item_id, embedding) VALUES (?, ?)')
    .run(itemId, vecLiteral(embedding));
}

/** Does an item have a stored embedding? (was `item.embedding IS NOT NULL`). */
export function hasEmbedding(itemId: string): boolean {
  return !!queryOne('SELECT 1 AS x FROM item_embeddings WHERE item_id = ?', itemId);
}

const vecLiteral = (v: number[]) => `[${v.join(',')}]`;

/**
 * KNN over item_embeddings (cosine distance, same metric pgvector's <=> used).
 * Over-fetches, then applies visibility/hidden filtering against items.
 * `viewerId` null → shared items only (e.g. MCP); a user id → shared + their private.
 */
function knnVisible(
  embeddingExpr: string,
  params: unknown[],
  limit: number,
  viewerId: string | null,
): { id: string; dist: number }[] {
  const knn = query<{ item_id: string; distance: number }>(
    `SELECT item_id, distance FROM item_embeddings
     WHERE embedding MATCH ${embeddingExpr} AND k = ?`,
    ...params,
    limit + 40,
  );
  if (!knn.length) return [];
  const ids = knn.map((r) => r.item_id);
  const visible = new Set(
    query<{ id: string }>(
      `SELECT id FROM items WHERE id IN (${placeholders(ids.length)})
       AND hidden_at IS NULL AND (is_private = 0 OR owner_id = ?)`,
      ...ids,
      viewerId,
    ).map((r) => r.id),
  );
  return knn
    .filter((r) => visible.has(r.item_id))
    .slice(0, limit)
    .map((r) => ({ id: r.item_id, dist: r.distance }));
}

export async function nearestByVector(vec: number[], limit = 25, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return knnVisible('?', [vecLiteral(vec)], limit, viewerId);
}

export async function nearestToItem(itemId: string, limit = 12, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return knnVisible(
    `(SELECT embedding FROM item_embeddings WHERE item_id = ?)`,
    [itemId],
    limit,
    viewerId,
  ).filter((n) => n.id !== itemId);
}
