# Stash

Self-hosted home inventory for people who won't fill in forms. See `PLAN.md` for the concept.

## Stack

- **Server:** Node.js (TypeScript), Fastify, Drizzle ORM on Postgres (node: `postgres.js`)
- **Client:** React + Vite PWA (offline outbox, camera QR scan, hardware-scanner keyboard-wedge support)
- **DB:** `postgres:18` (full-text search + `pg_trgm`/`fuzzystrmatch` fuzzy matching)
- **Deploy:** one app container + one Postgres container via `docker compose`

## Run

```sh
docker compose up --build
```

App is at http://localhost:8080. Migrations run automatically on boot. Photos live in the `stash_data` volume.

Print labels from `/labels` - QR codes encode `<origin>/l/<code>`, so print them from the URL you'll actually scan against.

## Label printers

Add printers on the `/labels` page. Three connection types:

- **Zebra / ZPL (network)** - raw ZPL (native `^BQ` QR codes) sent to the printer's IP on port 9100. No drivers needed; works with Zebra and ZPL-compatible printers.
- **CUPS queue** - prints a rendered PNG through `lp` to a named queue (e.g. a Dymo driver on a CUPS server). Set the queue name and optionally the CUPS server host.
- **DYMO (DYMO Connect)** - prints from the browser via the DYMO Web Service; DYMO Connect must be running on the machine doing the printing. The printer name must match DYMO's.

## AI suggestions (optional)

Configure on the `/settings` (`Setup`) page: any OpenAI-compatible vision endpoint (`{base_url}/chat/completions`). Works with Ollama (`http://host.docker.internal:11434/v1`), LM Studio, llama.cpp, or hosted providers. New photos get a suggested name/description/tags in the background; accept, edit, or ignore - it never overwrites your text.

Visual search runs in-process via CLIP (transformers.js/ONNX, ~580MB model cached in `/data/models`): every photo gets an embedding in pgvector, powering "similar items" on item pages and photo-based search - plus CLIP text-image matching blended into text search. No extra container.

## Barcode recognition

Barcodes/QRs in item photos are detected both at capture (browser BarcodeDetector/zxing) and on the server (zxing-wasm). When one is spotted you're asked "same item?" - yes attaches it as the item's `barcode`. Confirmed codes get a free product lookup (OpenFoodFacts → OpenProductsFacts → OpenBeautyFacts, no key; misses are silently skipped) and the result feeds the AI prompt as context. `GET /api/codes/:code/lookup` exposes the lookup directly.

## Accounts & privacy

Auth is [Better Auth](https://better-auth.com) (email + password, secure session cookies). First visit asks you to create the first household account; after that, sign-up is closed and logged-in members add people from Settings → Household.

Items are **shared with the household by default**. Toggle "Private" on an item to make it visible only to you - hidden from other users' lists, search, and API, and invisible to MCP connections entirely.

## MCP

The MCP endpoint is off by default. Settings → "MCP connections" creates a named connection with its **own URL** (`<host>/mcp/<slug>`) **and a separate bearer token** - paste both into a ChatGPT/Claude connector (URL field + auth field), revoke either independently. Tools: `search_items`, `list_areas`, `area_contents`, `item_details`, `move_item`, `resolve_label`. Hosted connectors require public HTTPS - front it with a reverse proxy, Tailscale Funnel, or Cloudflare Tunnel.

## Develop

```sh
# Postgres only
docker compose up db

npm install
DATABASE_URL=postgres://stash:stash@localhost:5432/stash npm run dev
```

- Server: http://localhost:8080 (`server/`, `tsx` watch)
- Client: http://localhost:5173 (`client/`, Vite dev server, proxies `/api` + `/photos`)

## Layout

- `server/` - Fastify API, Drizzle schema, SQL migrations, photo storage
- `client/` - React PWA
- `data/` - local photo storage when running outside Docker (gitignored)

## Roadmap status

Done: core loop (areas, labels, photo filing, browsing, search), move/lend/not-here, inbox triage, undo, offline outbox, printable label sheets, Zebra/CUPS/DYMO label printing, AI name/description/tag suggestions, in-container CLIP visual search (similar items + photo search), barcode detection + free product lookup, per-connection MCP endpoints.

Not yet: pile-splitting, receipt ingestion, warranties/low-stock, multi-user auth.
