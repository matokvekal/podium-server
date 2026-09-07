-- 031-analytics-events.sql — an append-only server-side log of meaningful business events.
--
-- WHY THIS TABLE EXISTS
--   There is no way to answer "how many rides were created in August", "public vs private",
--   "which countries are active" without either scraping the business tables (which change
--   shape and lose history — a cancelled ride, a deleted route) or bolting on a third-party
--   analytics SDK. This is the smallest thing that is neither: one row per business action,
--   written right after the action succeeds, never read on the request path.
--
--   It is DELIBERATELY not a counter table. The raw rows are the source of truth; every number
--   is a COUNT over them (see the view below). Nothing to keep in sync, nothing to drift — the
--   same rule sql/018 and sql/025 already follow.
--
-- CRITICAL: NON-FATAL
--   The server writes these through src/audit/audit.service.ts::trackAuditEvent, which catches
--   every error (including 42P01 — this file not yet run) and only logs a warning. A ride is
--   created, a rider joins, a route is copied — all succeed whether or not this table exists or
--   the insert works. Analytics is never a dependency of business behaviour.
--
-- NAMING
--   `ride_id`, not `event_id`: `event_type` here is the ANALYTICS event, and El Niño's business
--   `events` table is rides. The column points at events.id (a UUID) all the same — FK-free per
--   the house rule, like every other cross-table reference in this schema.
--
-- SHAPE
--   id               BIGINT identity       — internal row id, same as route_copies / entitlement_grants
--   event_type       VARCHAR(40) NOT NULL  — USER_REGISTERED | RIDE_CREATED | RIDE_JOINED |
--                                            RIDE_LEFT | ROUTE_CREATED | ROUTE_COPIED |
--                                            ROUTE_DOWNLOADED  (src/audit/audit.constants.ts)
--   event_time       TIMESTAMPTZ NOT NULL  — when the action happened (= when the row was written)
--   user_id          BIGINT   NULL         — users.id
--   ride_id          UUID     NULL         — events.id
--   route_id         BIGINT   NULL         — routes.id
--   country_code     CHAR(2)  NULL         — the ride's country (events.country), uppercase ISO-3166-1
--   ride_visibility  VARCHAR(20) NULL      — public | registered | private
--   details          JSONB NOT NULL        — optional extras that don't deserve a column yet
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/031-analytics-events.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. New table + indexes + a view; nothing
-- existing is read or written.

CREATE TABLE IF NOT EXISTS analytics_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type      VARCHAR(40) NOT NULL,
    event_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    user_id         BIGINT,
    ride_id         UUID,
    route_id        BIGINT,

    country_code    CHAR(2),
    ride_visibility VARCHAR(20),

    details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- "events of type X over a time range", and the view's GROUP BY.
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time
    ON analytics_events (event_type, event_time);

-- "activity in country X over time".
CREATE INDEX IF NOT EXISTS idx_analytics_events_country_time
    ON analytics_events (country_code, event_time)
    WHERE country_code IS NOT NULL;

-- "everything that happened to this ride / this route / by this user".
CREATE INDEX IF NOT EXISTS idx_analytics_events_ride  ON analytics_events (ride_id)  WHERE ride_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_events_route ON analytics_events (route_id) WHERE route_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_events_user  ON analytics_events (user_id)  WHERE user_id  IS NOT NULL;

-- Read-only convenience: open the DB, see daily counters per type / country / visibility.
-- Not read by any application code — a business flow must never query this.
CREATE OR REPLACE VIEW analytics_daily_summary AS
SELECT
    event_time::date AS event_date,
    event_type,
    country_code,
    ride_visibility,
    COUNT(*)         AS total
FROM analytics_events
GROUP BY event_time::date, event_type, country_code, ride_visibility;

-- Verify afterwards:
--   SELECT * FROM analytics_daily_summary ORDER BY event_date DESC, event_type;
--   SELECT event_type, COUNT(*) FROM analytics_events GROUP BY 1 ORDER BY 1;
