import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const env = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://stash:stash@localhost:5432/stash',
  // Photos on disk. In Docker: /data volume. Locally: <repo>/data.
  dataDir: process.env.DATA_DIR ?? path.resolve(here, '../../data'),
  // Built PWA. In Docker: /app/client/dist. In dev the Vite server serves it.
  clientDist: process.env.CLIENT_DIST ?? path.resolve(here, '../../client/dist'),
  migrationsDir: process.env.MIGRATIONS_DIR ?? path.resolve(here, '../migrations'),
  isProd: process.env.NODE_ENV === 'production',
};
