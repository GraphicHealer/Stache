# Stache

Self-hosted, photo-first home inventory for people who won't fill in forms.

**"Where is my stuff?"** - snap a photo, drop the thing in a bin, scan the bin's QR label. No names required, no categories, no forms. Finding it later is search, photo similarity, or just looking inside the bin from your couch.

Everything runs in a single container - no database service, no external anything. Works offline, works on phones, works on Zebra handhelds with a scan trigger.

## Features

- **Capture-first filing** - a photo is a complete record. Name it later, or never.
- **QR-labeled areas** - rooms, closets, shelves, bins nest arbitrarily. Print sequential labels, claim them by scanning.
- **Find anything** - exact, fuzzy, and typo-tolerant text search, barcode lookup, and search-by-photo via local CLIP embeddings.
- **Out tracking** - "out" vs "unaccounted for" states, one-tap put-back, a quiet Still-out widget, and an optional bundled digest. No badges, no overdue red.
- **Undo everything** - filing, moving, deleting, status changes. Nothing is destroyed, only hidden.
- **Optional AI** - any OpenAI-compatible vision model (Ollama, LM Studio, hosted) suggests names/descriptions/tags, reads text in photos, splits pile photos into items - always as suggestions you confirm.
- **Household accounts** - shared inventory by default, per-item private toggle, email/password auth.
- **Label printers** - Zebra/ZPL over the network, CUPS queues, or DYMO Connect.
- **MCP + webhooks** - per-connection MCP endpoints for ChatGPT/Claude, a Home Assistant sensor, and a digest webhook for reminders.
- **Offline PWA** - photos and scans queue locally in bad signal and sync when you're back.

## Quick start

```sh
docker compose pull && docker compose up -d   # prebuilt image
# or build from source:
docker compose up -d --build
```

Open `http://<host>:8080`, create the first household account, then head to `/labels` to print your first batch.

Requirements: Docker + Docker Compose. One container (`ghcr.io/graphichealer/stache`) - the embedded SQLite database, photos, and AI model cache all live in the `stache_data` volume at `/data`. Backup is copying that volume.

**Memory:** the app idles around 200MB. CLIP (photo similarity) loads lazily on the first photo upload or photo search, not at boot - once warm the app sits around 450-550MB. On very small hosts, set `STACHE_NO_ML=1` to disable embeddings entirely; everything else keeps working.

## How it works

1. **Print labels** (`/labels`) - sequential QRs like `ST-000001`. Stick them on bins, shelves, drawers.
2. **Claim a label** - scan an unclaimed one, take a photo of the area, done. It becomes a scannable container.
3. **Put things away** - scan a label to set the current area, then snap photos. Or snap first, scan after.
4. **Find things** - search by name, description, barcode, or photo; or scan a bin to see inside it.

## Optional pieces

Everything below is off by default - the app is fully usable without any of it.

**AI** (Settings → Setup): point at any OpenAI-compatible `/chat/completions` endpoint (`http://host.docker.internal:11434/v1` for Ollama) with a vision model. New photos get suggested names/tags/descriptions in the background, CLIP powers visual search in-process, and "Split pile…" breaks a photo of many things into separate items you approve.

**Out reminders** (Settings → Out reminders): one bundled digest POST to any webhook (ntfy, Discord, Home Assistant), daily at a time you pick or triggered externally. Snoozable per item, never per-item pings.

**Home Assistant**: two ways in -

[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FGraphicHealer%2FStache)

Click the badge to add this repo to your add-on store, then install **Stache** and open its Web UI on port 8080. (Manual path: Settings → Add-ons → Add-on Store → ⋯ → Repositories → paste `https://github.com/GraphicHealer/Stache`.)

[![Add Stache integration via HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=GraphicHealer&repository=stache-ha&category=integration)

For sensors inside Home Assistant, there's a [HACS integration](https://github.com/GraphicHealer/stache-ha) - items out, unaccounted, low stock, and warranty-expiring sensors fed by the app's webhook. From inside Stache, Settings also shows a ready-made REST sensor URL and a digest trigger URL for automations without the integration.

**MCP** (Settings → MCP connections): each connection gets its own `/mcp/<slug>` URL plus a separate bearer token. Eight tools - search, areas, contents, details, move, resolve label, `add_item`, `update_item` - so assistants can answer "where is my soldering iron" or file receipts and voice descriptions for you. Front with HTTPS to expose externally.

## Unraid

Single container, no database service - the appdata folder holds everything. A ready-made Community Applications template and full install guide live in [`unraid/`](unraid/unraid.md).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Web port |
| `DATA_DIR` | `/data` | SQLite db + photos + AI model cache |
| `DB_PATH` | `$DATA_DIR/stache.db` | SQLite file location |
| `TZ` | `UTC` | Digest schedule timezone |
| `BETTER_AUTH_SECRET` | auto-generated | Session secret (persisted in DB) |
| `STACHE_NO_ML` | unset | `1` disables CLIP embeddings/photo similarity |

As a Home Assistant add-on the same image is used; the add-on's data dir maps to `/data`, so nothing else is needed.

Everything else - AI provider, printers, MCP connections, digest webhooks - is configured in the app's Settings page.

## Development

```sh
npm install
npm run dev            # server on :8080, Vite dev server on :5173; db file in ./data
```

Migrations live in `server/migrations/` and apply on boot. See `AGENTS.md` for architecture notes and conventions, `PLAN.md` for the design philosophy.

## Releasing

Publish a GitHub Release and Actions builds + pushes `ghcr.io/graphichealer/stache:<version>` and `:latest` for amd64 and arm64, with the version baked into the Settings footer and `/api/health`.

## License

TBD.
