-- 021-events-elevation-gain.sql — the organizer's authoritative elevation-gain value for an
-- event, independent of any attached route.
--
-- WHY THIS COLUMN EXISTS
--   Total climb is already stored per-route in routes.elevation_m (sql/004-routes.sql), filled
--   in from a GPX/TCX import at upload time. That is the right home for "this line climbs 820 m"
--   — a route is reusable across events.
--
--   It is the wrong home for two cases the product needs:
--     * the organizer entered elevation by hand and the event has NO route at all
--       (Create Event with no GPX) — routes rows require geometry, so there is nowhere to put it;
--     * the organizer imported a GPX that DID carry elevation, then corrected the number.
--
--   events.elevation_gain_m is that value. The server returns the EFFECTIVE elevation as
--   COALESCE(events.elevation_gain_m, <attached route>.elevation_m), so:
--     - GPX carried elevation, organizer left it        -> route value shows through (NULL here)
--       (the client also echoes the imported number back into this column on save, so a saved
--        event usually has it set either way)
--     - GPX had no elevation, organizer typed one       -> this column
--     - organizer corrected the imported number         -> this column wins
--     - old event, nobody ever set anything             -> NULL, exactly as today
--
-- NULLABLE, NO DEFAULT. NULL means "no organizer-set value" — fall back to the route, then to
-- nothing. Every existing row is NULL and keeps behaving exactly as it does now.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/021-events-elevation-gain.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default
-- is metadata-only in PostgreSQL 11+, so it does not rewrite the table.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS elevation_gain_m DOUBLE PRECISION;

-- A climb figure is a non-negative number of metres. NULL (the inherit/none case) passes.
-- ADD CONSTRAINT has no IF NOT EXISTS, so it is guarded to keep this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_elevation_gain_m_non_negative'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_elevation_gain_m_non_negative
            CHECK (elevation_gain_m IS NULL OR elevation_gain_m >= 0);
    END IF;
END $$;

-- No index: elevation_gain_m is only ever read as part of a row already being selected by id
-- or by the owner/participant filters, never filtered or sorted on.
