-- 041-event-trail-metadata.sql — three descriptive fields for off-road (mtb / gravel) tracks.
--
--   events.route_difficulty  VARCHAR(16)  easy | moderate | hard | challenging   (NULL = not stated)
--   events.season            VARCHAR(24)  all_year | all_year_summer_ok | winter_spring | spring_autumn
--   events.shade             VARCHAR(16)  shaded | partial | exposed
--
-- WHY THESE ARE NEW COLUMNS AND NOT EXISTING ONES
--   * route_difficulty is how hard the TRACK is. events.level (sql/010) is who the RIDE is pitched
--     at (fitness / pace) and events.terrain_grade (sql/038) is what is under the tyre, 1-5. The
--     three are orthogonal, and neither existing field can honestly carry "this track is hard",
--     so both stay exactly as they are.
--   * season and shade have no equivalent anywhere.
--
-- WHY ON events, NOT routes
--   Everything Find Tracks filters and shows — area, region, duration, climb, level, terrain —
--   is read from the event row that carries the track (GET /events/public). These sit beside
--   them for the same reason terrain_grade does.
--
-- THE VALUE SETS
--   Taken from the 1009 curated MTB tracks (MTB-SINGELS): 4 difficulties, 4 seasons, 3 shade
--   levels — every one observed, none invented. They are stable English KEYS; the Hebrew words
--   are the client's (src/lib/trail-metadata.ts). Validated by zod (schemas/event.schemas.ts) and,
--   like events.region, deliberately NOT a database CHECK, so a value can be added without a
--   migration.
--
-- WHO COLLECTS THEM
--   mtb and gravel only — a product rule in the client, not a schema rule. Road rides leave all
--   three NULL, and a value is kept (not cleared) if an organizer switches discipline and back.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs. Reads are SELECT e.* and map
--   row.x ?? null; writes go through updateEventRidePlan -> updateEventColumns, which drops only
--   the column a 42703 names. The three public-list filters add their WHERE clause only when the
--   caller actually sends that filter, so a database without these columns still lists normally.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/041-event-trail-metadata.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS, nullable, no
-- default: metadata-only in PostgreSQL 11+, no rewrite, no backfill. Nothing existing is touched.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS route_difficulty VARCHAR(16),
    ADD COLUMN IF NOT EXISTS season           VARCHAR(24),
    ADD COLUMN IF NOT EXISTS shade            VARCHAR(16);

COMMENT ON COLUMN events.route_difficulty IS 'How hard the track is: easy | moderate | hard | challenging. NULL = not stated. Unrelated to events.level (rider pitch) and events.terrain_grade (ground).';
COMMENT ON COLUMN events.season IS 'When the track is pleasant to ride: all_year | all_year_summer_ok | winter_spring | spring_autumn. NULL = not stated.';
COMMENT ON COLUMN events.shade IS 'How much of the track is shaded: shaded | partial | exposed. NULL = not stated.';

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name IN ('route_difficulty', 'season', 'shade');
--   -- expect 3 rows, all character varying, all YES
