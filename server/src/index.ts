import { runMigrations } from './migrate';
import { initAuth } from './auth';
import { ensurePhotoDir } from './lib/photos';
import { buildApp } from './app';
import { startAiWorker } from './lib/ai';
import { startDigestScheduler } from './lib/digest';
import { env } from './env';

async function main() {
  await ensurePhotoDir();
  await runMigrations((msg) => console.log(`[migrate] ${msg}`));
  await initAuth();
  startAiWorker();
  startDigestScheduler();
  // Note: CLIP loads lazily on first embed (ml.ts), not here - keeps boot light.

  const app = buildApp();
  await app.listen({ port: env.port, host: env.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
