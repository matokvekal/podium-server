-- 043-route-imported-counts.sql — an imported starting popularity for a track, kept apart from
-- real user actions.
--
--   routes.imported_download_count  INTEGER NOT NULL DEFAULT 0
--   routes.imported_like_count      INTEGER NOT NULL DEFAULT 0
--
--   displayed downloads = imported_download_count + COUNT(route_copies rows)
--   displayed likes     = imported_like_count     + COUNT(route_likes rows)
--
-- WHY THIS EXISTS
--   A library imported in bulk starts with every track at 0 hearts and 0 downloads, which makes
--   the sort-by-popularity views meaningless until riders have used it. The imported tracks get a
--   seeded starting figure instead.
--
-- WHY NOT ROWS
--   route_likes / route_copies (sql/025, sql/036) are append-only ledgers of REAL riders' actions,
--   and their counts are derived from the rows so they cannot drift. Faking a starting count with
--   rows would need fake users (or a real user "liking" 60 times), and would corrupt exactly the
--   thing those ledgers exist to protect. So the seed is a plain number beside them, and the two
--   are ADDED at read time. Real likes and downloads are untouched and behave exactly as before.
--
-- DEFAULT 0
--   Every existing route reads as 0 imported, so nothing changes for a route that was never
--   imported. NOT NULL so there is no third state to reason about.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs: the count queries retry
--   without the seed column when it is missing (42703), so a database that has not reached this
--   migration simply shows real counts only.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/043-route-imported-counts.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with a constant
-- default is metadata-only in PostgreSQL 11+: no rewrite, no long lock.

ALTER TABLE routes
    ADD COLUMN IF NOT EXISTS imported_download_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS imported_like_count     INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN routes.imported_download_count IS 'Starting "downloads" from an import; ADDED to the count of route_copies rows. Never a user action.';
COMMENT ON COLUMN routes.imported_like_count IS 'Starting "likes" from an import; ADDED to the count of route_likes rows. Never a user action.';

-- Verify afterwards:
--   SELECT column_name, data_type, column_default FROM information_schema.columns
--    WHERE table_name = 'routes' AND column_name LIKE 'imported_%';
--   -- expect 2 rows: integer, default 0
