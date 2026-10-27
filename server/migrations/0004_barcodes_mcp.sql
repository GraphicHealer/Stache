ALTER TABLE items ADD COLUMN detected_codes jsonb;

CREATE TABLE mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE, -- in the URL: /mcp/<slug>
  token text NOT NULL UNIQUE, -- separate bearer auth token
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
