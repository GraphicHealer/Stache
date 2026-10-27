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

## Out & missing items

Items not in their home container are tracked in two states: **out** (you took it, it comes back) and **unaccounted for** (reported "not here", or out 30+ days). An item's `area_id` stays its home, so "put back" is one tap with no scan - scanning a container's QR while things are out of it offers to mark them returned.

- **Home widget** - "Still out" row of big thumbnails (newest first, "+N more"), tap to put back. Hidden entirely when nothing is out. Neutral styling, no badges, no overdue language.
- **`/out` page** - everything out of place, Out and Unaccounted as separate sections grouped by area, sorted by time out ("out 3 days"). Multi-select + bulk put-back, per-item put back / mark gone / snooze reminders.
- **Usage data** - taking an item out silently records `last_used` and increments `takeout_count`; shown on the item page. No extra input.
- **Reminders (optional)** - Settings → "Out reminders" posts **one bundled digest** (photos + names) to any webhook URL, at a daily time (container `TZ`) or when triggered. Snoozed items are skipped.
- **Home Assistant** - `GET /api/webhooks/out-sensor?token=…` returns `{out_count, unaccounted_count, total, items:[{name, path, days}], low_stock, warranty_expiring}` for a REST sensor; `POST /api/webhooks/digest?token=…` fires the digest from an automation. Both URLs shown with copy buttons in Settings.

## Optional details

Two fields on the item page (under "Details"), both fully optional and never in the filing flow:

- **Warranty until** - a date. Items with warranties ending within 30 days show quietly in the Inbox, digest, and sensor.
- **Restock when below** - a number for consumables. When quantity drops to it, the item appears in a "Running low" Inbox section plus digest/sensor data. No alerts, no nagging.

## AI area suggestions

On an item page, if CLIP has seen enough similar photos, a "Similar things live in" card suggests the area those look-alikes already live in (nearest-embedding neighbors, similarity-weighted). One tap moves it there, undoable like every move. `GET /api/items/:id/suggested-area` exposes it.

## Accounts & privacy

Auth is [Better Auth](https://better-auth.com) (email + password, secure session cookies). First visit asks you to create the first household account; after that, sign-up is closed and logged-in members add people from Settings → Household.

Items are **shared with the household by default**. Toggle "Private" on an item to make it visible only to you - hidden from other users' lists, search, and API, and invisible to MCP connections entirely.

## MCP

The MCP endpoint is off by default. Settings → "MCP connections" creates a named connection with its **own URL** (`<host>/mcp/<slug>`) **and a separate bearer token** - paste both into a ChatGPT/Claude connector (URL field + auth field), revoke either independently. Tools: `search_items`, `list_areas`, `area_contents`, `item_details`, `move_item`, `resolve_label`, `add_item`, `update_item`. The two write tools open integrations like receipt ingestion (an assistant files delivered purchases via `add_item`, with an `area_name` it finds or creates) and voice descriptions (`update_item` applies spoken names/notes/status). Hosted connectors require public HTTPS - front it with a reverse proxy, Tailscale Funnel, or Cloudflare Tunnel.

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

Done: core loop (areas, labels, photo filing, browsing, search), move/lend/not-here, out-vs-unaccounted tracking with one-tap put-back, bundled digest reminders + Home Assistant sensor, household auth + per-item privacy, card-style inbox triage (Right/Fix/Later), optional warranty + low-stock tracking, AI area suggestions, undo, offline outbox, printable label sheets, Zebra/CUPS/DYMO label printing, AI name/description/tag suggestions, in-container CLIP visual search (similar items + photo search), barcode detection + free product lookup, per-connection MCP endpoints with write tools (add_item, update_item).

Not yet: pile-splitting, receipts parsed in-app (covered via MCP add_item instead), voice input in-app (covered via MCP update_item).
