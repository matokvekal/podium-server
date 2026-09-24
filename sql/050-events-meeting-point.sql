-- 050-events-meeting-point.sql — an organizer-set meeting point, independent of the route.
--
-- WHY THIS COLUMN EXISTS
--   The map pin and the Waze/Google-Maps links on an event page use the attached route's first
--   point (route.points[0]) as "where this ride is" — there is nowhere else coordinates are
--   captured (lib/weather.ts, lib/nav-links.ts on the client). That is right for almost every
--   ride: you meet where the route starts.
--
--   It is wrong when the group actually meets somewhere ELSE — a parking lot a few hundred
--   metres from the singletrack's own trailhead, a cafe before a road ride's first pedal stroke
--   — asked for directly ("route.points[0] = actual cycling route start, meetingPoint = nearby
--   parking lot"). These two columns are that override.
--
--   NULLABLE, NO DEFAULT, ALWAYS BOTH OR NEITHER. NULL/NULL means "no override — use the
--   route's start point", exactly today's behaviour, so every existing event keeps working
--   unchanged. The pair is always written and cleared together (see
--   updateEventMeetingPoint in event.queries.ts) — there is no meaning to only one being set.
--
--   Changing this NEVER touches the route or its geometry: the GPX/track stays exactly what was
--   uploaded, this is purely "where do we meet before riding it".
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/050-events-meeting-point.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default is
-- metadata-only in PostgreSQL 11+, so it does not rewrite the table.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS meeting_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS meeting_lon DOUBLE PRECISION;

-- Real coordinates or nothing — and always as a pair. ADD CONSTRAINT has no IF NOT EXISTS, so
-- each is guarded to keep this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_meeting_lat_range'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_meeting_lat_range
            CHECK (meeting_lat IS NULL OR (meeting_lat >= -90 AND meeting_lat <= 90));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_meeting_lon_range'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_meeting_lon_range
            CHECK (meeting_lon IS NULL OR (meeting_lon >= -180 AND meeting_lon <= 180));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_meeting_point_pair'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_meeting_point_pair
            CHECK ((meeting_lat IS NULL) = (meeting_lon IS NULL));
    END IF;
END $$;

-- No index: read only as part of a row already selected by id, never filtered or sorted on.
