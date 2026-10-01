-- 057-ai-search-prep.sql — schema ONLY for the coming AI / free-text track search.
--
-- ⚠ ALREADY APPLIED ON PRODUCTION (2026-10-01) under its draft name 050-ai-search-prep.sql —
--   renumbered to 057 because main already had 050-056. Safe to re-run (all IF NOT EXISTS).
--
--   routes.ai_search_text        TEXT         NULL
--   routes.ai_search_updated_at  TIMESTAMPTZ  NULL
--   routes.ai_search_version     INTEGER      NOT NULL DEFAULT 1
--   events.route_info_processed  BOOLEAN      NOT NULL DEFAULT false
--
-- WHAT THIS DOES NOT DO
--   No UPDATE, no backfill, no copy of existing data, no index, no extension, no
--   vector/embedding column. Nothing existing is altered or dropped. The backfill is a separate
--   step, run only after this file is confirmed applied on production. pg_trgm is in its own
--   optional file, 057a-enable-pg-trgm.sql, so a missing privilege there can never make this
--   migration report failure.
--
-- EXISTING ROWS
--   routes: ai_search_text / ai_search_updated_at stay NULL ("never built");
--           ai_search_version reads as 1.
--   events: route_info_processed reads as false ("not processed yet").
--   On PostgreSQL 11+ a constant DEFAULT on ADD COLUMN is metadata-only: the value is not
--   written into existing rows and the table is not rewritten.
--
-- TIMESTAMPTZ, not TIMESTAMP: every timestamp in this schema is TIMESTAMPTZ since
-- 900-timestamptz-migration.sql.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/057-ai-search-prep.sql
--
-- SAFE ON LIVE DATA and safe to run more than once (every statement is IF NOT EXISTS).
-- One transaction: all four columns land, or none do.

BEGIN;

ALTER TABLE routes ADD COLUMN IF NOT EXISTS ai_search_text       TEXT;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS ai_search_updated_at TIMESTAMPTZ;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS ai_search_version    INTEGER NOT NULL DEFAULT 1;

ALTER TABLE events ADD COLUMN IF NOT EXISTS route_info_processed BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- Verify afterwards:
--   SELECT table_name, column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE (table_name = 'routes' AND column_name LIKE 'ai_search_%')
--       OR (table_name = 'events' AND column_name = 'route_info_processed')
--    ORDER BY 1, 2;
--   -- expect 4 rows:
--   --   events | route_info_processed | boolean                  | NO  | false
--   --   routes | ai_search_text       | text                     | YES |
--   --   routes | ai_search_updated_at | timestamp with time zone | YES |
--   --   routes | ai_search_version    | integer                  | NO  | 1
