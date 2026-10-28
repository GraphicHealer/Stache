-- Stache initial schema - SQLite dialect.
-- Timestamps are INTEGER unix ms; booleans INTEGER; JSON is TEXT.
-- Embeddings live in the vec0 virtual table (requires sqlite-vec, loaded by
-- the app before migrations run). Full-text index lives in items_fts (FTS5)
-- kept fresh by triggers.

CREATE TABLE labels (
  code TEXT PRIMARY KEY,
  batch INTEGER NOT NULL DEFAULT 1,
  area_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
  name TEXT,
  cover_photo_id TEXT,
  label_code TEXT UNIQUE REFERENCES labels(code),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  archived_at INTEGER
);
CREATE INDEX areas_parent_idx ON areas(parent_id);

CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  name TEXT,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  barcode TEXT,
  status TEXT NOT NULL DEFAULT 'home'
    CHECK (status IN ('home', 'out', 'lent', 'unaccounted', 'gone')),
  lent_to TEXT,
  out_since INTEGER,
  last_used_at INTEGER,
  takeout_count INTEGER NOT NULL DEFAULT 0,
  remind_snoozed_until INTEGER,
  warranty_until TEXT,
  restock_below INTEGER,
  not_here_count INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  ai_name TEXT,
  ai_description TEXT,
  ai_tags TEXT,
  ai_status TEXT NOT NULL DEFAULT 'off',
  ocr_text TEXT,
  detected_codes TEXT,
  owner_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  is_private INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX items_area_idx ON items(area_id);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  area_id TEXT REFERENCES areas(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  thumb_path TEXT,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  CHECK ((item_id IS NULL) <> (area_id IS NULL))
);
CREATE INDEX photos_item_idx ON photos(item_id);
CREATE INDEX photos_area_idx ON photos(area_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload TEXT,
  undone_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX events_created_idx ON events(created_at);

CREATE TABLE printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT,
  port INTEGER NOT NULL DEFAULT 9100,
  queue TEXT,
  dpi INTEGER NOT NULL DEFAULT 203,
  label_w_mm REAL NOT NULL DEFAULT 57,
  label_h_mm REAL NOT NULL DEFAULT 32,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at INTEGER
);

-- Full-text search over items (name/description/barcode), kept fresh by
-- triggers. Item ids are TEXT so a normal FTS5 table stores them as an
-- unindexed column alongside the indexed text.
CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  name,
  description,
  barcode,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER items_fts_ins AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(item_id, name, description, barcode)
  VALUES (new.id, new.name, new.description, new.barcode);
END;
CREATE TRIGGER items_fts_del AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;
CREATE TRIGGER items_fts_upd AFTER UPDATE OF name, description, barcode ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
  INSERT INTO items_fts(item_id, name, description, barcode)
  VALUES (new.id, new.name, new.description, new.barcode);
END;

-- CLIP embeddings (512-dim, cosine distance - same metric pgvector's <=> used).
CREATE VIRTUAL TABLE item_embeddings USING vec0(
  item_id TEXT PRIMARY KEY,
  embedding FLOAT[512] distance_metric=cosine
);
