ALTER TABLE items DROP CONSTRAINT items_status_check;
ALTER TABLE items ADD CONSTRAINT items_status_check
  CHECK (status IN ('home', 'out', 'lent', 'unaccounted', 'gone'));
ALTER TABLE items ADD COLUMN last_used_at timestamptz;
ALTER TABLE items ADD COLUMN takeout_count integer NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN remind_snoozed_until timestamptz;

CREATE INDEX items_status_idx ON items(status) WHERE hidden_at IS NULL;
