-- 022-event-ride-plan.sql — three organizer-set planning fields on an event:
--   * how long the ride is expected to take (duration_min)
--   * how many rest / regroup stops it has (rest_stops)
--   * whether it is suitable for riders who need assistance / adaptive equipment (is_accessible)
--
-- WHY THESE COLUMNS EXIST
--   The create form collects them, and a browsing rider wants all three before joining: an
--   "Est. Time" figure the card already has a slot for (it read "soon" until now), the number
--   of places the group will stop to regroup, and an accessibility marker so a rider who needs
--   help knows the ride is planned for it.
--
--   None of this can be derived — duration is not distance / an assumed speed (this app does
--   not ship invented numbers), rest stops are a plan the organizer makes, and accessibility
--   is a claim only the organizer can make. So they are stored, not computed.
--
-- SHAPES
--   duration_min   INTEGER  NULL  — expected ride time in whole minutes. NULL = not stated
--                                   (the card keeps showing "soon"). CHECK > 0.
--   rest_stops     SMALLINT NULL  — 0 means "no stops", NULL means "not stated". CHECK 0..20.
--   is_accessible  BOOLEAN  NOT NULL DEFAULT FALSE — every existing row backfills to FALSE,
--                                   i.e. "not marked accessible", which is the safe default.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/022-event-ride-plan.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS is metadata-only
-- in PostgreSQL 11+ (the BOOLEAN default included — a constant default does not rewrite the
-- table since PG 11), so it does not lock the table for a rewrite.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS duration_min  INTEGER,
    ADD COLUMN IF NOT EXISTS rest_stops    SMALLINT,
    ADD COLUMN IF NOT EXISTS is_accessible BOOLEAN NOT NULL DEFAULT FALSE;

-- ADD CONSTRAINT has no IF NOT EXISTS — guarded so this file stays re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_duration_min_positive'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_duration_min_positive
            CHECK (duration_min IS NULL OR duration_min > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_rest_stops_range'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_rest_stops_range
            CHECK (rest_stops IS NULL OR (rest_stops >= 0 AND rest_stops <= 20));
    END IF;
END $$;

-- No index: all three are only ever read as part of a row already selected by id or by the
-- owner / participant filters, never filtered or sorted on.
