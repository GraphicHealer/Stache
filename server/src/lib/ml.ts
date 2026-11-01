import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { query, queryOne, sqlite, placeholders } from '../db';
import { env } from '../env';

/**
 * In-process CLIP (ViT-B/32, q8) via transformers.js + onnxruntime-node.
 * Loads lazily on first embed - never at boot, so a cold start stays light.
 * Models download once into DATA_DIR/models (~350MB disk).
 *
 * STACHE_ML_LEVEL picks the stack (all lazy-loaded):
 *   0 - no ML at all (extremely small hosts)
 *   1 - CLIP + Florence-2 (light VLM, no text context)
 *   2 - CLIP + LFM2.5-VL-450M (prompted VLM - default)
 *   3 - CLIP + Moondream2 (heavier prompted VLM)
 * Legacy STACHE_NO_ML=1 still means "off".
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

const rawLevel = process.env.STACHE_ML_LEVEL ?? (process.env.STACHE_NO_ML === '1' ? '0' : '2');
const parsedLevel = parseInt(rawLevel, 10);
/** Env level: 0=off, 1=Florence-2, 2=LFM2.5-VL (default), 3=Moondream2. */
const envLevel = Number.isNaN(parsedLevel) ? 2 : Math.min(3, Math.max(0, parsedLevel));
export const mlDisabled = envLevel === 0;

// Settings can override the env level (AI settings -> local model picker).
// Env 0 stays a hard off - a tiny host opted out on purpose.
let levelCache: number | null = null;
export function invalidateMlLevel(): void {
  levelCache = null;
}
export async function activeMlLevel(): Promise<number> {
  if (mlDisabled) return 0;
  if (levelCache == null) {
    const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'ml_level');
    const v = row ? (JSON.parse(String(row.value)) as { level?: number }).level : undefined;
    levelCache = typeof v === 'number' ? Math.min(3, Math.max(0, v)) : envLevel;
  }
  return levelCache;
}

async function rawImage(buf: Buffer) {
  const hf = await import('@huggingface/transformers');
  const { data, info } = await sharp(buf)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new hf.RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
}

async function loadClip(): Promise<Clip> {
  if (mlDisabled) throw new Error('ML disabled (STACHE_ML_LEVEL=0)');
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
        clipFailed = false;
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

/** Kick a background CLIP load - callers get text-only results until it lands. */
export function warmClip(): void {
  if (mlDisabled) return;
  ensureClip().catch(() => {});
}

// Inference is serialized: ONNX calls are CPU-bound and unbounded bursts
// would starve small hosts. One at a time, queued.
let inferenceChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = inferenceChain.then(fn);
  inferenceChain = p.catch(() => {});
  return p;
}

export async function embedImage(buf: Buffer): Promise<number[]> {
  return serialize(async () => {
    const clip = await ensureClip();
    const image = await rawImage(buf);
    const inputs = await clip.processor(image);
    const { image_embeds } = await clip.vision(inputs);
    return l2norm(image_embeds.data as Float32Array);
  });
}

export async function embedText(text: string): Promise<number[]> {
  return serialize(async () => {
    const clip = await ensureClip();
    const inputs = clip.tokenizer([text], { padding: true, truncation: true });
    const { text_embeds } = await clip.textModel(inputs);
    return l2norm(text_embeds.data as Float32Array);
  });
}

/**
 * CLIP-embeds a photo and stores the vector keyed by photo_id (an item can
 * have several photos; all of them get vectors). Then looks for a
 * near-identical photo on a different item and flags it as a possible
 * duplicate - a hint shown at filing time.
 */
export async function analyzeItemPhoto(itemId: string, photoId: string, photoPath: string): Promise<void> {
  const buf = await fs.readFile(path.join(env.dataDir, 'photos', photoPath));
  const embedding = await embedImage(buf);
  sqlite
    .prepare('INSERT OR REPLACE INTO photo_embeddings (photo_id, item_id, embedding) VALUES (?, ?, ?)')
    .run(photoId, itemId, vecLiteral(embedding));

  const dup = knnVisible('?', [vecLiteral(embedding)], 8, null).find(
    (n) => n.id !== itemId && n.dist < 0.06,
  );
  sqlite
    .prepare('UPDATE items SET duplicate_of = ? WHERE id = ?')
    .run(dup?.id ?? null, itemId);
}

/** Does an item have a stored embedding? (was `item.embedding IS NOT NULL`). */
export function hasEmbedding(itemId: string): boolean {
  return !!queryOne('SELECT 1 AS x FROM photo_embeddings WHERE item_id = ?', itemId);
}

const vecLiteral = (v: number[]) => `[${v.join(',')}]`;

/**
 * KNN over photo_embeddings (cosine distance, same metric pgvector's <=> used).
 * Multiple photos can map to one item - deduped to best distance per item.
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
    `SELECT item_id, distance FROM photo_embeddings
     WHERE embedding MATCH ${embeddingExpr} AND k = ?`,
    ...params,
    limit + 80,
  );
  if (!knn.length) return [];
  const best = new Map<string, number>();
  for (const r of knn) {
    if (!best.has(r.item_id) || r.distance < best.get(r.item_id)!) {
      best.set(r.item_id, r.distance);
    }
  }
  const ids = [...best.keys()];
  const visible = new Set(
    query<{ id: string }>(
      `SELECT id FROM items WHERE id IN (${placeholders(ids.length)})
       AND hidden_at IS NULL AND (is_private = 0 OR owner_id = ?)`,
      ...ids,
      viewerId,
    ).map((r) => r.id),
  );
  return ids
    .filter((id) => visible.has(id))
    .map((id) => ({ id, dist: best.get(id)! }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

export async function nearestByVector(vec: number[], limit = 25, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return knnVisible('?', [vecLiteral(vec)], limit, viewerId);
}

export async function nearestToItem(itemId: string, limit = 12, viewerId: string | null = null): Promise<{ id: string; dist: number }[]> {
  return knnVisible(
    `(SELECT embedding FROM photo_embeddings WHERE item_id = ? LIMIT 1)`,
    [itemId],
    limit,
    viewerId,
  ).filter((n) => n.id !== itemId);
}

// ---------------------------------------------------------------------------
// Built-in VLM per level. Same lazy pattern as CLIP - downloads into
// DATA_DIR/models on first use only.
//   1 - Florence-2: fixed-task captioning/OCR/OD, fast, no free-text prompts
//   2 - LFM2.5-VL-450M: edge-tuned chat VLM, name/barcode as context, OD
//   3 - Moondream2: bigger prompted VLM for hosts with headroom
// ---------------------------------------------------------------------------
type VlmKind = 'florence' | 'lfm2vl' | 'moondream';
function vlmFor(level: number): { kind: VlmKind; model: string; dtype: Record<string, string> } {
  if (level <= 1)
    return {
      kind: 'florence',
      model: 'onnx-community/Florence-2-base-ft',
      dtype: { embed_tokens: 'fp32', vision_encoder: 'fp32', encoder_model: 'fp32', decoder_model_merged: 'q4' },
    };
  if (level === 2)
    return {
      kind: 'lfm2vl',
      model: 'LiquidAI/LFM2.5-VL-450M-ONNX',
      dtype: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' },
    };
  return {
    kind: 'moondream',
    model: 'Xenova/moondream2',
    dtype: { embed_tokens: 'fp32', vision_encoder: 'fp16', decoder_model_merged: 'q4' },
  };
}
// Kind of the loaded model - set by loadVlm, read by vlmAsk's arg ordering.
let vlmKind: VlmKind = 'lfm2vl';

// Download progress for the Settings UI + corner banner.
const dl = {
  state: 'idle' as 'idle' | 'downloading' | 'ready' | 'failed',
  file: '',
  files: new Map<string, { loaded: number; total: number }>(),
};
export function vlmStatus(): {
  state: string;
  file: string;
  downloaded: number;
  total: number;
  percent: number | null;
} {
  let loaded = 0;
  let total = 0;
  for (const f of dl.files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  return {
    state: dl.state,
    file: dl.file,
    downloaded: loaded,
    total,
    percent: total ? Math.round((loaded / total) * 100) : null,
  };
}

type Vlm = { model: any; processor: any; tokenizer: any };
let vlmPromise: Promise<Vlm> | null = null;

async function loadVlm(): Promise<Vlm> {
  if (mlDisabled) throw new Error('ML disabled (STACHE_ML_LEVEL=0)');
  const lvl = await activeMlLevel();
  const sel = vlmFor(Math.min(3, Math.max(1, lvl)));
  vlmKind = sel.kind;
  const hf = await import('@huggingface/transformers');
  hf.env.cacheDir = path.join(env.dataDir, 'models');
  dl.state = 'downloading';
  const track = (p: any) => {
    if (p.status === 'initiate') dl.file = p.file;
    else if (p.status === 'progress' || p.status === 'done')
      dl.files.set(p.file, { loaded: p.loaded ?? p.total ?? 0, total: p.total ?? 0 });
  };
  try {
    const [model, processor, tokenizer] = await Promise.all([
      (sel.kind === 'moondream'
        ? hf.Moondream1ForConditionalGeneration.from_pretrained(sel.model, {
            dtype: sel.dtype as any,
            session_options: SESSION_OPTS,
            progress_callback: track,
          })
        : hf.AutoModelForImageTextToText.from_pretrained(sel.model, {
            dtype: sel.dtype as any,
            session_options: SESSION_OPTS,
            progress_callback: track,
          })),
      hf.AutoProcessor.from_pretrained(sel.model),
      hf.AutoTokenizer.from_pretrained(sel.model),
    ]);
    dl.state = 'ready';
    scheduleModelPurge();
    return { model, processor, tokenizer };
  } catch (e) {
    dl.state = 'failed';
    throw e;
  }
}

export function ensureVlm(): Promise<Vlm> {
  if (!vlmPromise) {
    vlmPromise = loadVlm().catch((e) => {
      vlmPromise = null;
      throw e;
    });
  }
  return vlmPromise;
}

/** Kick a background VLM download - the model arrives before the first photo needs it. */
export function warmVlm(): void {
  if (mlDisabled) return;
  ensureVlm().catch(() => {});
}

// Once a newly selected model is ready, wait a grace period, then delete the
// OTHER known VLM dirs. The delay means an accidental click on the model
// picker doesn't destroy a 700MB download; switching back cancels it.
let purgeTimer: ReturnType<typeof setTimeout> | null = null;
const PURGE_DELAY_MS = 5 * 60_000;
export function scheduleModelPurge(): void {
  if (purgeTimer) clearTimeout(purgeTimer);
  purgeTimer = setTimeout(async () => {
    purgeTimer = null;
    try {
      const lvl = await activeMlLevel();
      const keep = vlmFor(Math.min(3, Math.max(1, lvl))).model;
      const modelsDir = path.join(env.dataDir, 'models');
      for (const other of [1, 2, 3]) {
        const m = vlmFor(other).model;
        if (m === keep) continue;
        const dir = path.join(modelsDir, m);
        await fs.rm(dir, { recursive: true, force: true });
        console.log(`[ml] purged unselected model ${m}`);
      }
    } catch (e) {
      console.error('[ml] model purge failed:', (e as Error).message);
    }
  }, PURGE_DELAY_MS);
  purgeTimer.unref?.();
}

/**
 * Ask the prompted VLM a free-text question about a photo (levels 2-3).
 * Returns the raw answer text. Shares the serialized inference queue.
 */
export async function vlmAsk(buf: Buffer, question: string, maxNewTokens = 256): Promise<string> {
  return serialize(async () => {
    const vlm = await ensureVlm();
    const image = await rawImage(buf);
    if (vlmKind === 'moondream') {
      const q = `<image>\n\nQuestion: ${question}\n\nAnswer:`;
      const textInputs = vlm.tokenizer(q);
      const visionInputs = await vlm.processor(image);
      const ids = await vlm.model.generate({
        ...textInputs,
        ...visionInputs,
        do_sample: false,
        max_new_tokens: maxNewTokens,
      });
      const decoded = vlm.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0] as string;
      const i = decoded.indexOf('Answer:');
      return (i >= 0 ? decoded.slice(i + 7) : decoded).trim();
    }
    const messages = [
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: question }] },
    ];
    const promptText = vlm.processor.apply_chat_template(messages, { add_generation_prompt: true });
    // Arg order differs per processor: LFM2-VL takes (images, text).
    const inputs = await vlm.processor(image, promptText);
    const ids = await vlm.model.generate({ ...inputs, do_sample: false, max_new_tokens: maxNewTokens });
    // Decode only the generated tokens - marker text differs per model.
    const promptLen = (inputs.input_ids?.dims?.at(-1) as number) ?? 0;
    const gen = promptLen ? ids.slice(null, [promptLen, null]) : ids;
    return (vlm.tokenizer.batch_decode(gen, { skip_special_tokens: true })[0] as string).trim();
  });
}

/** Run one Florence-2 task (`<CAPTION>`, `<OCR>`, `<OD>`, ...) on a photo.
 * Shares the same serialized queue as CLIP inference. Level 1 only. */
export async function vlmGenerate(buf: Buffer, task: string, maxNewTokens = 100): Promise<any> {
  return serialize(async () => {
    const vlm = await ensureVlm();
    const image = await rawImage(buf);
    const prompts = vlm.processor.construct_prompts(task);
    const textInputs = vlm.tokenizer(prompts);
    const visionInputs = await vlm.processor(image);
    const ids = await vlm.model.generate({
      ...textInputs,
      ...visionInputs,
      max_new_tokens: maxNewTokens,
    });
    const text = vlm.tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
    return {
      result: vlm.processor.post_process_generation(text, task, image.size),
      size: { width: image.width, height: image.height },
    };
  });
}

/** True once Florence-2 weights are on disk (Settings can show "downloaded"). */
export async function vlmDownloaded(): Promise<boolean> {
  try {
    const dir = path.join(env.dataDir, 'models');
    const walk = async (d: string, depth: number): Promise<boolean> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (/florence|smolvlm|moondream|lfm2/i.test(e.name)) return true;
        if (e.isDirectory() && depth < 3 && (await walk(path.join(d, e.name), depth + 1))) return true;
      }
      return false;
    };
    return await walk(dir, 0);
  } catch {
    return false;
  }
}
