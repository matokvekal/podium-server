-- 049-ride-stop-points.sql — break / coffee stops the ride's creator places on the map.
--
-- WHAT IT IS
--   One table. Each row is one stop on ONE ride: the creator's own label ("קפה אצל יוסי",
--   "Water at the spring"), a point, and a small kind for the icon. Riders see them on the ride
--   page map, the live map and the stop list, each with an "open in Google Maps" link.
--
-- WHY NOT AN EXISTING COLUMN
--   events.rest_stops (sql/022) is a typed NUMBER, not places — it stays exactly as it is and
--   still feeds the card chip and the duration estimate.
--   routes.markers (sql/004) belongs to the TRACK, and a track is shared and copied between
--   rides (sql/025). Stops belong to the RIDE: copying a track must not copy another
--   organizer's coffee stops.
--
-- SHAPE NOTES
--   ride_id is UUID to match events.id. No foreign keys, like every table in this schema
--   (sql/001-init.sql, sql/README.md). A cancelled ride is a soft cancel, so its stops stay.
--   The per-ride limit (default 5) is a server constant in src/config/ride-stops.ts so it can
--   change without a migration. The CHECKs below are loose backstops, not product rules.
--   Who may write is the server's rule (src/authz/policy.ts "event:manage_stops": the ride's
--   creator only); created_by records who did.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/049-ride-stop-points.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. Creates one new, empty table and one index.
-- Nothing existing is dropped, renamed, retyped, read or written. Until it runs, the server
-- answers every ride with "no stops" and the ride pages look exactly as they do today.

CREATE TABLE IF NOT EXISTS ride_stop_points (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id     UUID             NOT NULL,  -- events.id — the ride this stop belongs to
    label       VARCHAR(120)     NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
    lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
    kind        VARCHAR(20)      NOT NULL DEFAULT 'coffee',  -- coffee | water | food | regroup | other
    sort_order  SMALLINT         NOT NULL DEFAULT 0,
    created_by  BIGINT           NOT NULL,  -- users.id
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_stop_points_ride
    ON ride_stop_points (ride_id, sort_order, id);

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT count(*) FROM ride_stop_points;   -- expect 0
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ride_stop_points' ORDER BY 1;
--   -- expect: idx_ride_stop_points_ride, ride_stop_points_pkey
--
-- Roll back (only if nothing has been saved yet that should be kept):
--   DROP TABLE IF EXISTS ride_stop_points;
