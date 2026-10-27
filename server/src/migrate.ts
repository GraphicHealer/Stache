import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from './db';
import { env } from './env';

export async function runMigrations(log: (msg: string) => void = console.log) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
  );
  const files = readdirSync(env.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    log(`applying migration ${file}`);
    const body = readFileSync(path.join(env.migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
  }
}
