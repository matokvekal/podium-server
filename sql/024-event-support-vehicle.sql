-- 024-event-support-vehicle.sql — one organizer-set flag on an event:
--   * whether the ride is followed by a support / sag vehicle (has_support_vehicle)
--
-- WHY THIS COLUMN EXISTS
--   It is a fact only the organizer knows and one riders actively look for before committing
--   to a long or remote ride: is there a vehicle behind the group that can pick up a rider who
--   punctures out, cracks, or gets hurt. Nothing in the data can imply it — not distance, not
--   rider count, not the route — so like duration_min and is_accessible in sql/022 it is
--   stored, never derived.
--
--   It is deliberately a separate column and NOT folded into is_accessible or a generic
--   "amenities" blob: they answer different questions, they are shown separately, and a
--   dedicated boolean is the cheapest thing to filter on later if browsing ever needs it.
--
-- SHAPE
--   has_support_vehicle  BOOLEAN NOT NULL DEFAULT FALSE
--
--   NOT NULL with a FALSE default rather than a nullable tri-state, matching is_accessible.
--   Every existing ride backfills to FALSE, which reads as "no support vehicle stated" — the
--   safe answer, and the one the UI shows as simply "no badge". There is no useful difference
--   here between "the organizer said no" and "the organizer did not say": a rider must not
--   plan around a vehicle nobody promised.
--
-- BACKWARDS COMPATIBILITY
--   Every existing row gets FALSE and stays valid. The server reads events with `SELECT *` and
--   maps `row.has_support_vehicle ?? false`, and writes go through updateEventRidePlan, which
--   is already guarded by isMissingColumnError — so the code is safe to deploy both BEFORE and
--   AFTER this file runs. Before it runs the flag simply does not persist and the server logs
--   a warning naming this file.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/024-event-support-vehicle.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with a constant
-- default is metadata-only in PostgreSQL 11+ — no table rewrite, no long lock, no backfill
-- scan. Nothing is dropped, renamed, retyped or deleted.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS has_support_vehicle BOOLEAN NOT NULL DEFAULT FALSE;

-- No index and no constraint: a boolean needs no CHECK, and this column is only ever read as
-- part of a row already selected by id or by the owner / participant filters. If "rides with a
-- support vehicle" ever becomes a browse filter, add a partial index on the TRUE rows then.

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name = 'has_support_vehicle';
--   SELECT has_support_vehicle, count(*) FROM events GROUP BY 1;
