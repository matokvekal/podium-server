-- 038-event-terrain-grade.sql — how technical the ground is, 1-5, for off-road rides.
--
--   events.terrain_grade  SMALLINT 1..5, NULL = the organizer has not stated one.
--
-- WHY THIS EXISTS
--   The app already has events.level (beginner .. world_tour, sql/010-event-profile.sql), and
--   it is labelled "Difficulty" on every card. But that field answers WHO THE RIDE IS PITCHED
--   AT — fitness and pace — and for an off-road ride that is only half the question. A rider
--   deciding whether to come needs to know what is under the tyre: hardpack, roots, sand, mud,
--   drops. Those are independent. "Beginners pace over S3 singletrack" is a real and common
--   ride, and today the app cannot say it.
--
--   So this is a SECOND, ORTHOGONAL axis, not a replacement. level stays exactly as it is.
--
-- WHY 1..5 AND NOT A TEXT LABEL
--   The number is the portable part; the WORDS depend on the discipline and live in the client
--   (src/lib/terrain-grade.ts), the same way the five levels are relabelled as min/km for a
--   running event without five more columns:
--
--     mtb     1..5  ->  S1..S5, the Singletrail-Skala already painted on European trail signs
--     gravel  1..5  ->  G1..G5 surface grades (smooth dirt road .. sand/mud/chunky rock)
--
--   Storing "S3" would make the gravel scale a second column and the next discipline a third.
--   Storing 3 keeps one column and lets the vocabulary change without a migration.
--
-- WHY IT IS NOT CONSTRAINED TO mtb/gravel IN THE SCHEMA
--   Which disciplines COLLECT and SHOW a grade is a product rule, and product rules live in
--   the service and the client here (the same reasoning sql/036 used for "liking your own
--   track"). It also matters practically: an organizer who switches a ride from mtb to road and
--   back must not silently lose the grade they set, so the value is kept rather than cleared.
--
-- WHY NULLABLE WITH NO DEFAULT
--   NULL means "not stated", which is what every existing ride genuinely is and what a new ride
--   is until an organizer chooses. There is no honest default: defaulting to 1 would claim
--   every existing off-road ride is smooth hardpack. Reads render a dash, never a 1.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs, in either order.
--
--   Reads: every event read is SELECT * / SELECT e.* (queries/event.queries.ts), and mapEvent
--   coalesces `row.terrain_grade ?? null`, exactly as it does for country/region (sql/030) and
--   elevation_gain_m (sql/021). Before this file runs the column is simply absent and the
--   grade reads as "not stated".
--
--   Writes: the grade is written by updateEventRidePlan, which goes through updateEventColumns
--   — the writer that drops ONLY the column a 42703 names and retries with the rest. So on a
--   database without this column, duration_min / rest_stops / is_accessible / has_support_vehicle
--   / expected_participants are still written correctly and only the grade is skipped, with a
--   warning naming this file. Nothing an organizer typed is lost.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/038-event-terrain-grade.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. One nullable column and one CHECK are
-- added. No existing row is read or written; nothing is dropped, renamed or retyped. Every
-- existing ride keeps terrain_grade = NULL, i.e. exactly today's behaviour.

------------------------------------------------------------------------------------------
-- 1. The column
------------------------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN IF NOT EXISTS terrain_grade SMALLINT;

COMMENT ON COLUMN events.terrain_grade IS
    'How technical the ground is, 1-5 (mtb: S1-S5, gravel: G1-G5). NULL = not stated. Orthogonal to events.level, which is who the ride is pitched at.';

------------------------------------------------------------------------------------------
-- 2. The range
------------------------------------------------------------------------------------------

-- A CHECK, not an enum type: the range is fixed at five for every discipline, while the
-- LABELS are per-discipline and live in the client. NOT VALID is deliberately NOT used —
-- every existing row is NULL, so there is nothing to validate and the constraint is instant.
--
-- Guarded by a DO block because ADD CONSTRAINT has no IF NOT EXISTS, and this file must stay
-- re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_terrain_grade_range'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_terrain_grade_range
            CHECK (terrain_grade IS NULL OR terrain_grade BETWEEN 1 AND 5);
    END IF;
END
$$;

------------------------------------------------------------------------------------------
-- No index
------------------------------------------------------------------------------------------
-- Nothing filters or sorts on this yet: it is read as part of the event row that every card
-- already fetches. Add one the day a "terrain grade" filter lands on Find Rides, not before.

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name = 'terrain_grade';
--   -- expect: terrain_grade | smallint | YES
--
--   SELECT conname FROM pg_constraint WHERE conname = 'events_terrain_grade_range';
--   -- expect: events_terrain_grade_range
--
--   SELECT count(*) FROM events WHERE terrain_grade IS NOT NULL;   -- expect 0
--   SELECT count(*) FROM events;                                   -- expect unchanged
