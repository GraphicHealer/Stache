CREATE TABLE printers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('zpl', 'cups', 'dymo')),
  host text,          -- zpl: printer IP; cups: CUPS server
  port int NOT NULL DEFAULT 9100,
  queue text,         -- cups queue name
  dpi int NOT NULL DEFAULT 203,
  label_w_mm real NOT NULL DEFAULT 57,
  label_h_mm real NOT NULL DEFAULT 32,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

ALTER TABLE items
  ADD COLUMN ai_name text,
  ADD COLUMN ai_description text,
  ADD COLUMN ai_tags jsonb,
  ADD COLUMN ai_status text NOT NULL DEFAULT 'off' CHECK (ai_status IN ('off', 'pending', 'done', 'failed'));
