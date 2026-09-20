-- 046-route-thumb.sql — a tiny preview line for every route, embedded in the list responses.
--
--   routes.thumb_points  JSONB  NULL   { "p": [[lat, lng], ...60], "e": [metres, ...60] }
--
-- WHY THIS EXISTS
--   Find Tracks / My Rides cards drew their map from GET /events/:id/route, one request per card.
--   Scrolling ~12 pages (~290 cards) used up the API's 300-requests-per-15-minutes limit, after
--   which every map and the list itself failed ("Could not load tracks right now"). A card only
--   needs the SHAPE of the route, so that shape (60 points, ~1.2 KB, with a whole-metre elevation
--   series for the climb profile) now rides inside the paginated list response instead.
--
--   Three separate things, deliberately NOT merged:
--     thumb_points        this column   the card preview (list responses)
--     track_points        existing      the detailed line (GET /events/:id/route, on open/explore)
--     route_gpx_files     existing      the original GPX, byte-identical (GET /routes/:id/gpx)
--
-- WHAT THIS FILE DOES NOT DO
--   It adds a nullable column and nothing else. It does not read or change track_points,
--   preview_points, route_gpx_files or any event. The values are produced by
--   `npm run routes:thumbs` (dry run by default) from the STORED track_points — never from a GPX.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs. Before it: the list queries
--   and the route writers retry without the column (42703). After it but before the backfill: a
--   NULL thumb_points falls back to a preview derived at read time from preview_points.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/046-route-thumb.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: ADD COLUMN IF NOT EXISTS of a nullable
-- column with no default is metadata-only in PostgreSQL — no rewrite, no long lock.

ALTER TABLE routes
    ADD COLUMN IF NOT EXISTS thumb_points JSONB;

COMMENT ON COLUMN routes.thumb_points IS 'Card preview: {"p": [[lat,lng]...<=60], "e": [metres...]} derived from track_points. Display only; never the source of truth.';

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'routes' AND column_name = 'thumb_points';
--   -- expect 1 row: jsonb, YES
--   SELECT count(*) FILTER (WHERE thumb_points IS NULL) AS missing, count(*) AS total FROM routes;
