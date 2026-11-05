-- REST API tokens for integrations (Home Assistant, scripts, webhooks).
-- Mirrors mcp_tokens minus the slug: REST clients use one base URL + bearer.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'read-write',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_token_hash_idx ON api_tokens (token_hash);
