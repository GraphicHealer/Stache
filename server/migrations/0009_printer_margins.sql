-- Per-side print offsets for roll labels. Combined into ^LH x,y:
-- left(+right-in)/right(-), top(+down)/bottom(-up). top keeps the
-- v0.6.3 default of 1mm.
ALTER TABLE printers ADD COLUMN left_offset_mm REAL NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN right_offset_mm REAL NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN bottom_offset_mm REAL NOT NULL DEFAULT 0;
