-- 009-events-area.sql — free-text "area" field on events (e.g. region/neighbourhood),
-- alongside the existing `location` column. Same shape as location: optional, VARCHAR(255).
--
-- Safe to run on the live database: additive only.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS area VARCHAR(255);
