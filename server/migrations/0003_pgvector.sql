CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE items
  ADD COLUMN embedding vector(512),
  ADD COLUMN ocr_text text;

CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops);

-- Fold OCR text into full-text search.
CREATE OR REPLACE FUNCTION items_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.ocr_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.barcode, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
