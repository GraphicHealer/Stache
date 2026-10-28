-- Roles, event audit, hashed MCP tokens, per-photo embeddings, dup hints.

-- First household account is the admin; everyone else stays a member.
ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
UPDATE user SET role = 'admin'
WHERE id = (SELECT id FROM user ORDER BY created_at LIMIT 1);

-- "Sam moved the drill" - who did it (NULL = MCP/system).
ALTER TABLE events ADD COLUMN user_id TEXT;

-- Bearer tokens are stored hashed; plaintext is shown once at creation.
-- Rebuild so `token` (legacy plaintext) can be nulled after hashing - the
-- app computes SHA-256 at boot since SQLite has no digest function.
CREATE TABLE mcp_tokens_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  token TEXT,
  token_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at INTEGER
);
INSERT INTO mcp_tokens_v2 (id, name, slug, token, token_hash, created_at, last_used_at)
SELECT id, name, slug, token, NULL, created_at, last_used_at FROM mcp_tokens;
DROP TABLE mcp_tokens;
ALTER TABLE mcp_tokens_v2 RENAME TO mcp_tokens;

-- A hint that a newly-filed photo looks like an existing item.
ALTER TABLE items ADD COLUMN duplicate_of TEXT;

-- Embeddings keyed by photo, not item - every photo gets a vector, not just
-- the most recent one per item (the old PK silently dropped earlier photos).
CREATE VIRTUAL TABLE photo_embeddings USING vec0(
  photo_id TEXT PRIMARY KEY,
  item_id TEXT,
  embedding FLOAT[512] distance_metric=cosine
);
INSERT INTO photo_embeddings (photo_id, item_id, embedding)
SELECT
  (SELECT id FROM photos p WHERE p.item_id = e.item_id ORDER BY p.created_at LIMIT 1),
  e.item_id,
  e.embedding
FROM item_embeddings e
WHERE EXISTS (SELECT 1 FROM photos p3 WHERE p3.item_id = e.item_id);
DROP TABLE item_embeddings;
