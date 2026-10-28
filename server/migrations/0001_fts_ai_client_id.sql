-- Widen full-text search to AI-written fields (ai_name/ai_tags/ocr_text),
-- add a client idempotency key for offline-outbox replays, and index the
-- hot filter columns flagged in review.

DROP TRIGGER items_fts_ins;
DROP TRIGGER items_fts_del;
DROP TRIGGER items_fts_upd;
DROP TABLE items_fts;

CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  name,
  description,
  barcode,
  ai_name,
  ai_tags,
  ocr_text,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER items_fts_ins AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(item_id, name, description, barcode, ai_name, ai_tags, ocr_text)
  VALUES (new.id, new.name, new.description, new.barcode, new.ai_name, new.ai_tags, new.ocr_text);
END;
CREATE TRIGGER items_fts_del AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;
CREATE TRIGGER items_fts_upd AFTER UPDATE OF name, description, barcode, ai_name, ai_tags, ocr_text ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
  INSERT INTO items_fts(item_id, name, description, barcode, ai_name, ai_tags, ocr_text)
  VALUES (new.id, new.name, new.description, new.barcode, new.ai_name, new.ai_tags, new.ocr_text);
END;

INSERT INTO items_fts(item_id, name, description, barcode, ai_name, ai_tags, ocr_text)
SELECT id, name, description, barcode, ai_name, ai_tags, ocr_text FROM items;

-- Dedupes offline replays: a request that succeeded but lost its response
-- returns the existing item instead of filing a duplicate.
ALTER TABLE items ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX items_client_id_idx ON items(client_id) WHERE client_id IS NOT NULL;

CREATE INDEX items_barcode_idx ON items(barcode);
CREATE INDEX items_status_idx ON items(status);
CREATE INDEX events_entity_idx ON events(entity_id);
