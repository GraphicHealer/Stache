-- Review sweep: MCP scopes, event attribution, audit dates, purchase
-- records, user tags, receipts, item links, photo-lookup indexes.

-- Per-connection permission: 'read' or 'read-write'. Existing tokens keep
-- write access - that's what they already have.
ALTER TABLE mcp_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read-write';

-- Which MCP connection performed an event ('mcp:<slug>'); NULL = a person
-- (see user_id) or the system.
ALTER TABLE events ADD COLUMN actor TEXT;

-- Last completed stocktake - drives the area page's "audited ... ago" line.
ALTER TABLE areas ADD COLUMN last_audit_at INTEGER;

-- Filename lookups happen on every /photos/ request now (privacy check).
CREATE INDEX IF NOT EXISTS photos_path_idx ON photos(path);
CREATE INDEX IF NOT EXISTS photos_thumb_idx ON photos(thumb_path);

-- Optional purchase metadata - all NULL, never asked for at capture.
ALTER TABLE items ADD COLUMN purchase_date TEXT;   -- YYYY-MM-DD
ALTER TABLE items ADD COLUMN purchase_price REAL;  -- household currency
ALTER TABLE items ADD COLUMN retailer TEXT;
ALTER TABLE items ADD COLUMN serial_number TEXT;

-- User-editable cross-location tags (JSON array), separate from ai_tags.
ALTER TABLE items ADD COLUMN tags TEXT;

-- A receipt is a photo linked to any number of items (one receipt can cover
-- a whole shopping trip). Photos referenced here keep kind='receipt' usage
-- via membership in this table - no flag column needed.
CREATE TABLE item_receipts (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (item_id, photo_id)
);

-- "Goes with" links: device <-> charger, game <-> pieces. Symmetric - each
-- pair is stored once, ordered a_id < b_id.
CREATE TABLE item_links (
  a_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (a_id, b_id)
);
