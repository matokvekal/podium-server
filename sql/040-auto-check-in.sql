-- 040-auto-check-in.sql — riders can be marked "arrived" automatically, and the app can tell
-- an automatic arrival from one the organizer ticked by hand.
--
--   events.auto_check_in               BOOLEAN NOT NULL DEFAULT TRUE
--   event_participants.attendance_source  VARCHAR(10), 'manual' | 'auto' | NULL
--
-- WHY TWO COLUMNS AND NOT A NEW attendance_status VALUE
--   attendance_status ('unknown' | 'present' | 'dns' | 'started') answers "did they turn up".
--   HOW we know is a different question, so it is its own column. A new status such as
--   'present_auto' would have forced every reader of `present` — the organizer's counts, the
--   results "racing" rule, the pencil toggle, the safety check — to learn a second spelling of
--   the same fact. With a separate source, `present` still means present everywhere and only the
--   two places that WANT to show the difference read the source.
--
-- WHAT THE SOURCE IS FOR
--   * 'auto'   the server verified the rider's own GPS fix against the ride's start point and
--              start time (src/lib/auto-check-in.ts) and set attendance_status = 'present'.
--   * 'manual' an organizer wrote attendance (PATCH .../attendance). Every organizer write sets
--              this, INCLUDING un-ticking a rider back to 'unknown' — that is what stops the
--              app from ticking somebody the organizer just deliberately un-ticked.
--   * NULL     nobody has written attendance since this column existed. Every existing row.
--              A rider already marked 'present' before this migration therefore reads as a
--              manual arrival (only 'auto' is ever shown as automatic), which is what they were.
--
--   The automatic write is guarded `attendance_status = 'unknown' AND attendance_source IS NULL`,
--   so it can never overwrite an organizer's decision and is naturally idempotent.
--
-- WHY events.auto_check_in DEFAULTS TO TRUE
--   Asked for as "default on". It is NOT NULL so there is no third state to reason about. Existing
--   rides backfill to TRUE, which is harmless: the check only ever acts inside a window around
--   the ride's own start time, so a ride in the past is unaffected and an upcoming one simply
--   gets the feature. An organizer who does not want it turns it off on the ride's edit page.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs.
--
--   Reads: events are read with SELECT * and mapEvent coalesces `row.auto_check_in ?? false`, so
--   before this file runs auto check-in simply reads as OFF and the endpoint answers "disabled".
--   Participants are read with SELECT ep.*, and mapParticipant coalesces the source to null.
--
--   Writes: auto_check_in is written by updateEventRidePlan through updateEventColumns, which
--   drops ONLY the column a 42703 names — so the other ride-plan fields still save. The organizer
--   attendance write retries WITHOUT the source when the column is absent, so ticking riders off
--   keeps working on a database this file has not reached yet.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/040-auto-check-in.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with a constant
-- default is metadata-only in PostgreSQL 11+: no table rewrite, no long lock. Nothing is
-- dropped, renamed or retyped, and no existing attendance value is changed.

------------------------------------------------------------------------------------------
-- 1. The organizer's switch
------------------------------------------------------------------------------------------

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS auto_check_in BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN events.auto_check_in IS
    'When TRUE, a rider on the start list is marked arrived automatically if their own GPS is within the configured radius of the route start, inside the configured window around starts_at. Radius and window are server config (src/config/auto-check-in.ts), not stored per ride.';

------------------------------------------------------------------------------------------
-- 2. How a rider came to be marked arrived
------------------------------------------------------------------------------------------

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS attendance_source VARCHAR(10);

COMMENT ON COLUMN event_participants.attendance_source IS
    'Who last wrote attendance_status: auto = the server verified the rider''s own GPS; manual = an organizer; NULL = never written since this column existed.';

-- A CHECK rather than an enum type, matching every other status column here. Guarded by a DO
-- block because ADD CONSTRAINT has no IF NOT EXISTS and this file must stay re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'event_participants_attendance_source_check'
    ) THEN
        ALTER TABLE event_participants
            ADD CONSTRAINT event_participants_attendance_source_check
            CHECK (attendance_source IS NULL OR attendance_source IN ('manual', 'auto'));
    END IF;
END
$$;

------------------------------------------------------------------------------------------
-- No index
------------------------------------------------------------------------------------------
-- Neither column is filtered or sorted on. auto_check_in is read as part of the event row that
-- is already selected by id; attendance_source rides along on rows already selected by event.

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT table_name, column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE (table_name = 'events'             AND column_name = 'auto_check_in')
--       OR (table_name = 'event_participants' AND column_name = 'attendance_source');
--   -- expect: auto_check_in | boolean | NO | true     and     attendance_source | character varying | YES | NULL
--
--   SELECT auto_check_in, count(*) FROM events GROUP BY 1;                  -- every row TRUE
--   SELECT attendance_source, count(*) FROM event_participants GROUP BY 1;  -- every row NULL
