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

// Reject absurd decodes before they happen: every real phone photo fits
// under 250MP; a crafted bomb does not.
const MAX_INPUT_PIXELS = 250_000_000;

export class PhotoError extends Error {}

export async function ensurePhotoDir() {
  await fs.mkdir(PHOTO_DIR(), { recursive: true });
}

export interface SavedPhoto {
  path: string;
  thumbPath: string;
  width: number | null;
  height: number | null;
}

/** Cheap up-front check so a bad upload is refused before records exist. */
export async function assertImage(buf: Buffer): Promise<void> {
  await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().metadata();
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
  } catch (e) {
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
