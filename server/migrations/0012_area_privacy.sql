-- Private bins + sharing: file-permission-style inheritance. A private area
-- gates everything inside it (items and sub-areas) for its owner + share
-- list; nothing stores inherited state. Shares exist on areas AND items.
ALTER TABLE areas ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE areas ADD COLUMN owner_id TEXT REFERENCES user(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS object_shares (
  object_type TEXT NOT NULL,          -- 'area' | 'item'
  object_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (object_type, object_id, user_id)
);
CREATE INDEX IF NOT EXISTS object_shares_user_idx ON object_shares (object_type, user_id);
