-- 045-rider-stats-cache-columns.sql — brings rider_stats_cache up to the shape sql/035 describes.
--
--   rider_stats_cache.country      CHAR(2)                       (nullable)
--   rider_stats_cache.total_hours  DOUBLE PRECISION NOT NULL DEFAULT 0
--
-- WHY THIS EXISTS
--   sql/035 creates rider_stats_cache with `country` and `total_hours`, and src/statistics/ writes
--   both on every recompute (upsertStatsCache) and the National Leaderboard reads them (it ranks a
--   country's riders, and ranks by hours). A database whose rider_stats_cache was created from an
--   EARLIER version of 035 — before those two columns were added to the file — has the table but
--   not the columns, and 035's `CREATE TABLE IF NOT EXISTS` is then a no-op, so re-running 035
--   cannot fix it. Production was in exactly that state (found by a read-only schema check on
--   2026-09-20: user_id, year, rides_count, total_km, total_climb_m, total_calories, computed_at).
--
--   Without these columns every stats recompute fails at the INSERT (the finish hook logs and
--   swallows it, so a ride still finishes, but no cache is ever written) and the leaderboard
--   cannot be served.
--
-- THIS IS A CACHE, NOT A SOURCE OF TRUTH
--   Same rule as sql/035: every row can be rebuilt from event_participants / events /
--   participant_tracks. A new column that starts NULL / 0 on existing rows is therefore harmless
--   — those rows are recomputed on the rider's next read (24h) or the next ride they finish.
--   (Production has 0 rows here today.)
--
-- BACKWARDS COMPATIBILITY
--   Additive only. Nothing is dropped, renamed or retyped. Safe to run BEFORE or AFTER deploying
--   the statistics code, and on a database that already has both columns (IF NOT EXISTS).
--   ADD COLUMN with a constant DEFAULT is metadata-only in PostgreSQL 11+: no table rewrite, no
--   long lock.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/045-rider-stats-cache-columns.sql

ALTER TABLE rider_stats_cache
    ADD COLUMN IF NOT EXISTS country     CHAR(2),
    ADD COLUMN IF NOT EXISTS total_hours DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'rider_stats_cache' AND column_name IN ('country', 'total_hours');
--   -- expect: country | character | YES | (none)   and   total_hours | double precision | NO | 0
