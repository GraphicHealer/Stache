# Stash

Self-hosted, photo-first home inventory. "Where is my stuff?" - capture fast,
organize never (or later). Only containers (areas) get QR labels; items are
photos with optional names. Everything is undoable; AI suggests, never
overwrites.

## Stack

- `server/` - Fastify + TypeScript + Drizzle ORM on **embedded SQLite**
  (better-sqlite3). Vectors in `sqlite-vec` (vec0, cosine), full-text in
  FTS5 `items_fts` (trigger-synced), fuzzy ranking in `lib/textsearch.ts`.
  Bundled with esbuild (`--packages=external`); `tsc --noEmit` for typecheck.
- `client/` - React + Vite PWA (offline outbox in IndexedDB, service worker
  caching, camera-first UX, Zebra wedge-scanner input).
- `Dockerfile` - multi-stage: deps → build → runtime (`node:22-bookworm-slim`,
  non-root `node` user, `cups-client` for label printing).
- `docker-compose.yml` - a single `app` service, no DB container. Everything
  persists under `/data` (stash.db + photos + model cache).

## Build & verify

No host Node required - everything goes through Docker:

```sh
docker compose up -d --build   # builds server+client, runs migrations, starts app
curl localhost:8080/api/health
```

- Migrations live in `server/migrations/NNNN_name.sql` and auto-apply at boot.
  Add new ones as the next sequential file; never edit applied migrations.
- Server build: `npm run build -w server` (esbuild bundle + tsc typecheck).
- Client build: `npm run build -w client` (tsc --noEmit + vite build + PWA).
- Dev loop (needs local Node): `npm run dev` - SQLite file lands in `data/`.

## Key paths

| What | Where |
|------|-------|
| API routes | `server/src/routes/{areas,items,labels,search,settings,printers,out}.ts` |
| Out/missing | `server/src/lib/digest.ts` (statuses, digest, webhooks) |
| MCP endpoint | `server/src/mcp.ts` - `/mcp/<slug>` + separate bearer token |
| In-process CLIP | `server/src/lib/ml.ts` (transformers.js q8, lazy, `/data/models`) |
| Raw SQL helpers | `query`/`queryOne`/`placeholders` from `server/src/db/index.ts` |
| VLM suggestions | `server/src/lib/ai.ts` (OpenAI-compatible endpoint, optional) |
| Barcode detect/lookup | `server/src/lib/barcodes.ts` (zxing-wasm + Open*Facts) |
| Photo pipeline | `server/src/lib/photos.ts` (sharp: EXIF-rotate → webp + thumb) |
| Undo | `server/src/lib/events.ts` (`recordEvent` + inverse payloads) |
| DB schema | `server/src/db/schema.ts` (Drizzle) |
| Scan parsing | `client/src/scan.ts` (label vs product barcode) |

## Conventions & gotchas

- **Undo**: every mutation goes through `recordEvent` with enough `data` to
  reverse it; handlers return `event_id`/`event_ids` for the undo toast.
- **AI fields**: write `ai_*`/`detected_codes`/`embedding` only - never
  `name`/`description`. Blank/null beats guessing.
- **json columns** (`mode: 'json'`) come back `unknown` from Drizzle - cast
  before iterating. Timestamps are `timestamp_ms` INTEGER columns: always
  coerce JSON payload strings back to `Date` before `.set()`.
- **Multipart** parts are a union type - narrow on `part.type === 'file'`
  before `toBuffer()`.
- **sharp**: never reuse a pipeline; call `.metadata()` on a fresh instance.
  `sharp.concurrency(2)` caps libvips threads (small hosts stay responsive).
- **SPA fallback** serves index.html for unknown GETs - register API/special
  routes (like `/mcp`) explicitly or they'll 200 HTML.
- **SQLite notes**: uuids are app-side text (`$defaultFn`); no `ILIKE` (use
  `lower()` or `LIKE`); recursive CTEs and `json_extract` work; vec0 KNN is
  `embedding MATCH ? AND k = ?`; FTS5 query strings come from `ftsQuery()`.
- **Memory**: CLIP loads lazily on first embed (~200MB boot, ~450-500MB warm,
  q8 + 2 threads). `STASH_NO_ML=1` disables ML entirely for tiny hosts.
- **Zebra wedge scans** = rapid keystrokes ending in Enter (`parseScan`).
- `/data` must stay writable by the `node` user (db + photos + model cache).
- Docker daemon access may need `sg docker -c "..."` in a stale shell.

- **Auth**: Better Auth at `/api/auth/*` (`server/src/auth.ts`). First signup is
  open; afterward accounts are created by logged-in members via `POST /api/users`.
  Guard: `onRequest` hook in `app.ts` 401s `/api/*` + `/photos/*` without a
  session; `/api/auth`, `/api/health`, `/api/setup`, `/mcp` are open. Secret
  persists in `settings.auth_secret` (env `BETTER_AUTH_SECRET` overrides).
- **Privacy**: `items.is_private` + `items.owner_id`. Filter via
  `itemVisible(userId)` (drizzle) or `AND (is_private = 0 OR owner_id = ?)`
  in raw SQL. `req.user` is set by the guard. MCP sees shared items only.
  Drizzle export names `user`/`session`/`account`/`verification` are fixed -
  Better Auth's adapter looks them up by key.
- **Out/missing**: `status` is `home|out|lent|unaccounted|gone` (`gone` also
  sets `hidden_at`). `area_id` is always the home area - put-back is just
  `status='home'`, no move. Out for 30+ days displays as unaccounted.
  Timestamps crossing JSON (event payloads, PATCH bodies) arrive as strings -
  coerce to `Date` before drizzle `.set()` or you'll hit
  `value.toISOString is not a function`.
- **Digest/webhooks**: `/api/webhooks/*` are session-exempt but require the
  `settings.webhook_token` query param. Digest config lives in
  `settings.digest`; scheduler compares against container `TZ`.
- **Optional item fields**: `warranty_until` (TEXT 'YYYY-MM-DD') and
  `restock_below` (int). Low stock = `quantity <= restock_below`;
  surfaces in `/api/inbox`, the digest payload, and `out-sensor` - never alerts.
- **MCP writes**: `add_item` (files an item; resolves area by id/label/name,
  find-or-create on name) and `update_item` (fields + status, same event
  payloads as the PATCH route so undo works identically).

## Feature boundaries

- MCP is **off by default** - connections are created in Settings, each with
  its own `/mcp/<slug>` URL **and** separate bearer token (revocable).
- External barcode lookup is free-tier only (Open*Facts); misses return
  `product: null` - never error, never block filing.
- AI/ML is optional and non-blocking: filing works with no models loaded;
  CLIP embeds lazily in the background, `STASH_NO_ML=1` disables it fully.
