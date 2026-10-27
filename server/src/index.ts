import { sql } from './db';
import { runMigrations } from './migrate';
import { initAuth } from './auth';
import { ensurePhotoDir } from './lib/photos';
import { buildApp } from './app';
import { startAiWorker } from './lib/ai';
import { preloadClip } from './lib/ml';
import { startDigestScheduler } from './lib/digest';
import { env } from './env';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await ensurePhotoDir();

  // Postgres may still be starting - wait for it.
  for (let attempt = 0; ; attempt++) {
    try {
      await sql`SELECT 1`;
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await sleep(1000);
    }
  }

  await runMigrations((msg) => console.log(`[migrate] ${msg}`));
  await initAuth();
  startAiWorker();
  startDigestScheduler();
  preloadClip();

  const app = buildApp();
  await app.listen({ port: env.port, host: env.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
