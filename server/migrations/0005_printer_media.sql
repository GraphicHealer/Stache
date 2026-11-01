-- Printers can be single-label (label rolls) or sheet (laser + Avery-style
-- die-cut sheets). 'sheet' holds the template spec JSON for sheet mode.
ALTER TABLE printers ADD COLUMN media_type TEXT NOT NULL DEFAULT 'label';
ALTER TABLE printers ADD COLUMN sheet TEXT;
