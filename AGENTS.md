# Stash

Self-hosted, photo-first home inventory. "Where is my stuff?" — capture fast,
organize never (or later). Only containers (areas) get QR labels; items are
photos with optional names. Everything is undoable; AI suggests, never
overwrites.

## Stack

- `server/` — Fastify + TypeScript + Drizzle ORM on Postgres (pgvector).
  Bundled with esbuild (`--packages=external`); `tsc --noEmit` for typecheck.
- `client/` — React + Vite PWA (offline outbox in IndexedDB, service worker
  caching, camera-first UX, Zebra wedge-scanner input).
- `Dockerfile` — multi-stage: deps → build → runtime (`node:22-bookworm-slim`,
  non-root `node` user, `cups-client` for label printing).
- `docker-compose.yml` — `app` + `db` (`pgvector/pgvector:pg18`). One app
  container only — no separate ML/AI service; CLIP runs in-process.

## Build & verify

No host Node required — everything goes through Docker:

```sh
docker compose up -d --build   # builds server+client, runs migrations, starts app
curl localhost:8080/api/health
```

- Migrations live in `server/migrations/NNNN_name.sql` and auto-apply at boot.
  Add new ones as the next sequential file; never edit applied migrations.
- Server build: `npm run build -w server` (esbuild bundle + tsc typecheck).
- Client build: `npm run build -w client` (tsc --noEmit + vite build + PWA).
- Dev loop (needs local Node): `docker compose up db`, then `npm run dev`.

## Key paths

| What | Where |
|------|-------|
| API routes | `server/src/routes/{areas,items,labels,search,settings,printers}.ts` |
| MCP endpoint | `server/src/mcp.ts` — `/mcp/<slug>` + separate bearer token |
| In-process CLIP | `server/src/lib/ml.ts` (transformers.js, cache in `/data/models`) |
| VLM suggestions | `server/src/lib/ai.ts` (OpenAI-compatible endpoint, optional) |
| Barcode detect/lookup | `server/src/lib/barcodes.ts` (zxing-wasm + Open*Facts) |
| Photo pipeline | `server/src/lib/photos.ts` (sharp: EXIF-rotate → webp + thumb) |
| Undo | `server/src/lib/events.ts` (`recordEvent` + inverse payloads) |
| DB schema | `server/src/db/schema.ts` (Drizzle) |
| Scan parsing | `client/src/scan.ts` (label vs product barcode) |

## Conventions & gotchas

- **Undo**: every mutation goes through `recordEvent` with enough `data` to
  reverse it; handlers return `event_id`/`event_ids` for the undo toast.
- **AI fields**: write `ai_*`/`detected_codes`/`embedding` only — never
  `name`/`description`. Blank/null beats guessing.
- **jsonb columns** come back `unknown` from Drizzle — cast before iterating.
- **Multipart** parts are a union type — narrow on `part.type === 'file'`
  before `toBuffer()`.
- **sharp**: never reuse a pipeline; call `.metadata()` on a fresh instance.
- **SPA fallback** serves index.html for unknown GETs — register API/special
  routes (like `/mcp`) explicitly or they'll 200 HTML.
- **pg_trgm**: use explicit `word_similarity(...) > 0.3`, not the default
  `%` threshold; `fuzzystrmatch` gives levenshtein/soundex fallback.
- **Zebra wedge scans** = rapid keystrokes ending in Enter (`parseScan`).
- `/data` must stay writable by the `node` user (photos + model cache).
- Docker daemon access may need `sg docker -c "..."` in a stale shell.
- DB may warn about collation version mismatch (pgvector image vs older
  DB) — cosmetic; `ALTER DATABASE stash REFRESH COLLATION VERSION` clears it.

## Feature boundaries

- MCP is **off by default** — connections are created in Settings, each with
  its own `/mcp/<slug>` URL **and** separate bearer token (revocable).
- External barcode lookup is free-tier only (Open*Facts); misses return
  `product: null` — never error, never block filing.
- AI/ML is optional and non-blocking: filing works with no models loaded;
  embeddings degrade quietly until CLIP finishes caching.
