CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE labels (
  code text PRIMARY KEY,
  batch int NOT NULL DEFAULT 1,
  area_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES areas(id) ON DELETE SET NULL,
  name text,
  cover_photo_id uuid,
  label_code text UNIQUE REFERENCES labels(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX areas_parent_idx ON areas(parent_id);

ALTER TABLE labels
  ADD CONSTRAINT labels_area_fk FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE SET NULL;

CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid NOT NULL REFERENCES areas(id),
  name text,
  description text,
  quantity int NOT NULL DEFAULT 1,
  barcode text,
  status text NOT NULL DEFAULT 'home' CHECK (status IN ('home', 'out', 'lent')),
  lent_to text,
  out_since timestamptz,
  not_here_count int NOT NULL DEFAULT 0,
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector
);
CREATE INDEX items_area_idx ON items(area_id);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES items(id) ON DELETE CASCADE,
  area_id uuid REFERENCES areas(id) ON DELETE CASCADE,
  path text NOT NULL,
  thumb_path text,
  width int,
  height int,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((item_id IS NULL) <> (area_id IS NULL))
);
CREATE INDEX photos_item_idx ON photos(item_id);
CREATE INDEX photos_area_idx ON photos(area_id);

ALTER TABLE areas
  ADD CONSTRAINT areas_cover_fk FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  entity_type text,
  entity_id uuid,
  payload jsonb,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_created_idx ON events(created_at DESC);

-- Full-text search over items, kept fresh by trigger.
CREATE OR REPLACE FUNCTION items_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.barcode, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER items_search_trigger
  BEFORE INSERT OR UPDATE OF name, description, barcode ON items
  FOR EACH ROW EXECUTE FUNCTION items_search_update();

CREATE INDEX items_search_idx ON items USING gin(search_vector);
CREATE INDEX items_name_trgm ON items USING gin(coalesce(name, '') gin_trgm_ops);
CREATE INDEX items_desc_trgm ON items USING gin(coalesce(description, '') gin_trgm_ops);
CREATE INDEX areas_name_trgm ON areas USING gin(coalesce(name, '') gin_trgm_ops);
