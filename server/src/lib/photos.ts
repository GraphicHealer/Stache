import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { asc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { photos, type Photo } from '../db/schema';
import { env } from '../env';

const PHOTO_DIR = () => path.join(env.dataDir, 'photos');

// Keep libvips off all cores during bursts - small hosts stay responsive.
sharp.concurrency(2);

// Resource limits here are three separate controls, not one:
//   multipart cap (25MB/file, 30MB/request)  - bounds ENCODED upload size
//   MAX_INPUT_PIXELS (200MP ~ 800MB decoded) - bounds DECODED memory per image
//   photoGuard below                         - bounds concurrent OPERATIONS
// Decoded size dwarfs encoded size, so pixel count is the decode bound.
const MAX_INPUT_PIXELS = 200_000_000;

export class PhotoError extends Error {}
export class PhotoBusyError extends PhotoError {}

// Bounds concurrent image work at the REQUEST level (not just libvips
// threads). This is an operation limit, not a strict memory bound: each
// waiter only queues a closure, but its request may already hold uploaded
// buffers (up to ~30MB each) and each in-flight decode can take ~800MB.
// Worst case is bounded but bigger than a naive (2+16) x 25MB figure -
// roughly 2 decodes (~1.6GB) + 16 held request bodies (~480MB).
const PHOTO_CONCURRENCY = 2;
const PHOTO_WAITERS = 16;
let inFlight = 0;
const waiters: (() => void)[] = [];

async function photoGuard<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= PHOTO_CONCURRENCY) {
    if (waiters.length >= PHOTO_WAITERS) throw new PhotoBusyError('image processing busy');
    await new Promise<void>((r) => waiters.push(r));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

export async function ensurePhotoDir() {
  await fs.mkdir(PHOTO_DIR(), { recursive: true });
}

export interface SavedPhoto {
  path: string;
  thumbPath: string;
  width: number | null;
  height: number | null;
}

/** Deletes the files a SavedPhoto points at - rollback for failed uploads. */
export async function removePhotoFiles(s: SavedPhoto): Promise<void> {
  await fs.rm(path.join(PHOTO_DIR(), s.path), { force: true });
  await fs.rm(path.join(PHOTO_DIR(), s.thumbPath), { force: true });
}

/** Cheap up-front check so a bad upload is refused before records exist. */
export async function assertImage(buf: Buffer): Promise<void> {
  await photoGuard(() =>
    sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().metadata(),
  );
}

/** Stores an oriented original (max 1600px webp) plus a 320px thumb. */
export async function savePhotoFile(buf: Buffer): Promise<SavedPhoto> {
  await ensurePhotoDir();
  const id = crypto.randomUUID();
  const name = `${id}.webp`;
  const thumbName = `${id}_t.webp`;
  const out = path.join(PHOTO_DIR(), name);
  const thumb = path.join(PHOTO_DIR(), thumbName);
  const img = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS });
  try {
    return await photoGuard(async () => {
      const meta = await img().rotate().metadata();
      await img()
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(out);
      await img()
        .rotate()
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 70 })
        .toFile(thumb);
      return { path: name, thumbPath: thumbName, width: meta.width ?? null, height: meta.height ?? null };
    });
  } catch (e) {
    if (e instanceof PhotoBusyError) throw e;
    // Never leave a half-written pair on disk or a vague 500 for the client.
    await fs.rm(out, { force: true });
    await fs.rm(thumb, { force: true });
    throw new PhotoError(e instanceof Error ? e.message : 'invalid image');
  }
}

/** Regenerates the 320px thumb for an existing stored original. */
export async function regenerateThumb(p: Photo): Promise<string> {
  const thumbName = p.thumbPath ?? `${p.path.replace(/\.webp$/, '')}_t.webp`;
  await sharp(path.join(PHOTO_DIR(), p.path))
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 })
    .toFile(path.join(PHOTO_DIR(), thumbName));
  return thumbName;
}

export const photoDir = PHOTO_DIR;

export async function insertPhoto(
  saved: SavedPhoto,
  target: { itemId?: string; areaId?: string },
): Promise<Photo> {
  const [row] = await db
    .insert(photos)
    .values({ ...saved, itemId: target.itemId ?? null, areaId: target.areaId ?? null })
    .returning();
  return row;
}

export function photoUrl(p: Photo) {
  return `/photos/${p.path}`;
}
export function thumbUrl(p: Photo) {
  return `/photos/${p.thumbPath ?? p.path}`;
}

/** Oldest photo per item, for grids. ORDER BY keeps "first" deterministic. */
export async function thumbsForItems(itemIds: string[]): Promise<Map<string, Photo>> {
  const map = new Map<string, Photo>();
  if (itemIds.length === 0) return map;
  const rows = await db
    .select()
    .from(photos)
    .where(inArray(photos.itemId, itemIds))
    .orderBy(asc(photos.createdAt));
  for (const p of rows) if (!map.has(p.itemId!)) map.set(p.itemId!, p);
  return map;
}

/** Photos keyed by area id, oldest first. */
export async function photosForAreas(areaIds: string[]): Promise<Map<string, Photo[]>> {
  const map = new Map<string, Photo[]>();
  if (areaIds.length === 0) return map;
  const rows = await db
    .select()
    .from(photos)
    .where(inArray(photos.areaId, areaIds))
    .orderBy(asc(photos.createdAt));
  for (const p of rows) {
    const list = map.get(p.areaId!) ?? [];
    list.push(p);
    map.set(p.areaId!, list);
  }
  return map;
}

/** Cover thumbnails for a set of areas: explicit cover photo, else first photo. */
export async function coverThumbsForAreas(
  areaList: { id: string; coverPhotoId: string | null }[],
): Promise<Map<string, Photo>> {
  const map = new Map<string, Photo>();
  const byId = new Map(areaList.map((a) => [a.id, a]));
  const all = await photosForAreas(areaList.map((a) => a.id));
  for (const [areaId, list] of all) {
    const cover = byId.get(areaId)?.coverPhotoId;
    map.set(areaId, list.find((p) => p.id === cover) ?? list[0]);
  }
  return map;
}
