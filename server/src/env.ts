import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');

export const env = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  // Embedded SQLite lives in DATA_DIR next to the photos.
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'stache.db'),
  dataDir,
  // Photos on disk. In Docker: /data volume. Locally: <repo>/data.
  // Built PWA. In Docker: /app/client/dist. In dev the Vite server serves it.
  clientDist: process.env.CLIENT_DIST ?? path.resolve(here, '../../client/dist'),
  migrationsDir: process.env.MIGRATIONS_DIR ?? path.resolve(here, '../migrations'),
  // Baked at image build time by the release workflow.
  appVersion: process.env.APP_VERSION ?? 'dev',
  isProd: process.env.NODE_ENV === 'production',
  // Only trust X-Forwarded-* when a reverse proxy sets them deliberately.
  trustProxy: process.env.STACHE_TRUST_PROXY === '1',
  // Optional first-run gate: when set, the first sign-up needs this token.
  setupToken: process.env.STACHE_SETUP_TOKEN ?? '',
  // Public origin for auth callbacks + label/digest links when proxied.
  baseUrl: process.env.STACHE_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '',
  trustedOrigins: (process.env.STACHE_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
