import crypto from 'node:crypto';
import { runMigrations } from './migrate';
import { initAuth } from './auth';
import { ensurePhotoDir } from './lib/photos';
import { buildApp } from './app';
import { startAiWorker } from './lib/ai';
import { startDigestScheduler } from './lib/digest';
import { pruneEvents } from './lib/events';
import { sqlite } from './db';
import { env } from './env';

/** SQLite can't SHA-256, so legacy plaintext MCP tokens are hashed here at
 * boot (migration 0002 added the column). One-time: each row is hashed then
 * nulled, so a restart after this does nothing. */
function migrateMcpTokens() {
  const rows = sqlite
    .prepare(`SELECT id, token FROM mcp_tokens WHERE token IS NOT NULL`)
    .all() as { id: string; token: string }[];
  if (!rows.length) return;
  const upd = sqlite.prepare(
    `UPDATE mcp_tokens SET token_hash = ?, token = NULL WHERE id = ?`,
  );
  for (const r of rows) {
    upd.run(crypto.createHash('sha256').update(r.token).digest('hex'), r.id);
  }
  console.log(`[migrate] hashed ${rows.length} legacy MCP token(s)`);
}

async function main() {
  await ensurePhotoDir();
  await runMigrations((msg) => console.log(`[migrate] ${msg}`));
  migrateMcpTokens();
  await initAuth();
  startAiWorker();
  startDigestScheduler();
  // Events grow forever otherwise; 90d/20k cap keeps recent undo history.
  setInterval(() => {
    try {
      const n = pruneEvents();
      if (n) console.log(`[events] pruned ${n}`);
    } catch (e) {
      console.error('[events] prune failed:', (e as Error).message);
    }
  }, 6 * 3600_000);
  // Note: CLIP loads lazily on first embed (ml.ts), not here - keeps boot light.

  const app = buildApp();
  await app.listen({ port: env.port, host: env.host });

  // node is PID 1 (setpriv exec) - SIGTERM must close cleanly or docker stop
  // escalates to SIGKILL and the WAL can be left mid-transaction.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
