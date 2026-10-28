import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env } from '../env';
import * as schema from './schema';

// Single-file embedded DB living alongside the photos in DATA_DIR.
// sqlite-vec (vec0 virtual table) holds CLIP embeddings; items_fts (FTS5)
// holds the search index - both created in migrations.
fs.mkdirSync(env.dataDir, { recursive: true });

export const sqlite = new Database(env.dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqliteVec.load(sqlite);

export const db = drizzle(sqlite, { schema });

/** Prepared-statement helpers for raw SQL (vec0/FTS/CTEs - things drizzle can't express). */
export function query<T>(text: string, ...params: unknown[]): T[] {
  return sqlite.prepare(text).all(...(params as never[])) as T[];
}

export function queryOne<T>(text: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(text).get(...(params as never[])) as T | undefined;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
