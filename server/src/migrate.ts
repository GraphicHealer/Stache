import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sqlite, query } from './db';
import { env } from './env';

export async function runMigrations(log: (msg: string) => void = console.log) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )`);
  const applied = new Set(
    query<{ name: string }>(`SELECT name FROM _migrations`).map((r) => r.name),
  );
  const files = readdirSync(env.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    log(`applying migration ${file}`);
    const body = readFileSync(path.join(env.migrationsDir, file), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(body);
      sqlite.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
  }
}
