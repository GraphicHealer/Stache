-- User-editable tags on areas (JSON array), same shape as items.tags.
ALTER TABLE areas ADD COLUMN tags TEXT;
