# Stache Review: implementation spec

Triaged against `main`. Everything from the security sweep and the feature
list has shipped; this file now records what was deliberately deferred and
the principles future work should preserve. See git history for the
original findings.

------------------------------------------------------------------------

## Shipped in this sweep

**Security & correctness**

- `GET /api/users` - members see `{id, name, role}`; emails are admin-only.
- Private-item photos - `/photos/*` resolves filename → photo row → item →
  owner; non-owners get 404 (not 403 - existence isn't leaked). Signed
  digest URLs unchanged.
- Undo - refuses when a newer un-undone event exists on the same entity
  ("a newer change exists - undo that first"), including per-item checks
  inside stocktake batches.
- MCP - per-connection `read` / `read-write` scope (write tools unregistered
  for read-only), `events.actor = mcp:<slug>` attribution.
- AI `base_url` - http(s) only, blocks loopback/link-local/metadata targets;
  LAN hosts stay allowed (Ollama etc.); VLM response size capped.
- Rate limits - global API cap + tight limits on photo search, MCP, AI
  rerun, backfill, backup endpoints.
- Offline - outbox regression tests (order, 4xx parking, 5xx/network
  retry, client_id replay); server dedups `client_id`.

**Features**

- Areas - `?deep=1` recursive contents (items carry `area_name`), subtree
  item counts in listings, `last_audit_at`, `mark_unaccounted` toggle.
- Search - `area_id` covers the whole subtree; `tag=` filter; user tags
  join the fuzzy/FTS match surface.
- Items - per-item history endpoint + ItemPage timeline; purchase date /
  price / retailer / serial / tags (all optional, in "Details"); receipts
  (one photo → many items); "goes with" links (symmetric, undoable);
  merge-duplicates (photos + links move, loser hidden, one undo); photo
  replace (undoable - old files kept until the next mutation).
- Stocktake - review step (counts + mark-missing toggle), tick state
  persists in localStorage per area.
- Review queue - `/review` page + `/api/review-queue`: duplicates
  (merge either way / keep separate), unnamed items, failed-AI items
  with one-tap rerun.
- Import - `POST /api/import` (JSON; CSV parsed client-side), dry-run
  preview, per-row errors, area by id/label/name (find-or-create),
  area-less rows → "Unsorted", whole import one undoable event.
- Photo maintenance - orphan files / dangling rows / missing thumbs
  report + `delete_orphans` / `repair_thumbs` / `prune_dangling` actions.
- Backup - `POST /api/backup/download` ZIP (plaintext `manifest.json` +
  `payload.zip`, or `payload.enc` AES-256-GCM via scrypt passphrase or
  generated raw key; key shown once or embedded on opt-in).
  `POST /api/backup/restore` validates, stages to `restore-pending/`, and
  exits - the next boot swaps it in before the DB opens (Docker restarts
  automatically; `npm run dev` needs a manual restart).
- Voice notes - "Dictate" button appends SpeechRecognition transcripts to
  the Notes field; browser-native, no model, hidden when unsupported.
- Settings UI - all of the above (backup options/restore/import/maintenance,
  MCP scope picker), admin-gated where the endpoints are.
- Scheduled backups - opt-in (`settings.backup_schedule`, off by default):
  unencrypted bundles in `/data/backups`, every N days, keeps newest N.
  Encrypted bundles stay a manual download (no stored passphrase).

## Deliberately deferred
- **Server-side speech-to-text** - whisper in `ml.ts` would cover
  browsers without SpeechRecognition and recorded audio; not needed while
  dictation is a convenience, not a requirement.
- **Photos in JSON/CSV export** - intentionally excluded (binary bulk);
  the backup bundle is the full-fidelity path.
- **Bulk tag/private edits** - bulk move and bulk hide exist; multi-item
  field edits can ride the same select-mode UI if needed later.
- **Undo across restarts beyond the 90d window** - events prune at
  90 days / 20k; deeper history is an export concern.

## Product principles to preserve

Photo first. Optional metadata. Location central. AI suggests, users decide.
Private means private everywhere (API, search, photos, export, MCP).
Undo must not silently overwrite newer work. Backups must be restorable.
Keep the common path simple - power features live behind "Details".
