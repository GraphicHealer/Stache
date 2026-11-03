-- Per-printer vertical shift for roll labels (^LT). Positive = move the
-- printed content down; negative = up. 1mm default preserves v0.6.3's fix
-- for printers feeding slightly high.
ALTER TABLE printers ADD COLUMN top_offset_mm REAL NOT NULL DEFAULT 1;
