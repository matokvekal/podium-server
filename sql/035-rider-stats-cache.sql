-- 035-rider-stats-cache.sql — a per-rider, per-scope cache of computed Statistics totals.
--
-- WHY THIS TABLE EXISTS
--   Rider Statistics needs two expensive-ish things: (1) one rider's lifetime + this-year
--   totals, and (2) a leaderboard, which needs EVERY rider in one country at once to rank them.
--   Both are joins over event_participants + events + participant_tracks — cheap for one rider,
--   but the leaderboard doing that fresh, for every rider, on every page view, is real load for
--   no reason: a rider's lifetime totals only change when one of their rides finishes.
--
-- THIS TABLE IS A CACHE, NOT A SOURCE OF TRUTH.
--   Same rule as user_limits' own header, inverted: user_limits IS the answer because nothing
--   else can derive it. This is the opposite — event_participants/events/participant_tracks are,
--   and always remain, the only authoritative data. Every row here can be deleted and rebuilt
--   from scratch with no data loss, by construction.
--
-- SHAPE
--   One row per (user_id, year), where year = 0 means "lifetime" (a real year is never 0, so
--   this is an unambiguous sentinel — unlike NULL, which Postgres treats as never equal to
--   itself and would silently defeat (user_id, year) uniqueness for ON CONFLICT).
--   country is a SNAPSHOT of users.country as of the last recompute — denormalized here (rather
--   than joined from users on every leaderboard read) so the National Leaderboard query is a
--   single-table scan it can index directly. It is never the source of truth for a rider's
--   country; users.country always is. A rider with country IS NULL still gets a cache row (their
--   own personal totals still need one) but is absent from every country's leaderboard until
--   they set one — not a bug, the same "not yet computed" semantics the rest of this table uses.
--   total_calories: NULL when the rider has never set users.weight_kg (sql/034) — never a
--   number computed from a guessed weight.
--   computed_at: when this row was last (re)built. A read older than 24h is treated as stale
--   and recomputed — see STATS_CACHE_MAX_AGE_MS in statistics.service.ts.
--
-- INVALIDATION
--   Recomputed eagerly for every participant of an event the moment it reaches 'finished'
--   (event.service.ts's finish hook, alongside writeParticipantTracks) — so a rider sees their
--   new total the moment their ride ends, not up to 24h later. The 24-hour window above is the
--   fallback for the case nothing invalidated a row.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/035-rider-stats-cache.sql
--
-- SAFE ON LIVE DATA: new table, starts empty, nothing existing reads or writes it yet.

CREATE TABLE IF NOT EXISTS rider_stats_cache (
    user_id        BIGINT NOT NULL,   -- no FK, per the house rule in sql/README.md
    year           SMALLINT NOT NULL DEFAULT 0,  -- 0 = lifetime; otherwise a real calendar year
    country        CHAR(2),           -- snapshot of users.country at compute time; may be NULL
    rides_count    INT NOT NULL DEFAULT 0,
    total_km       DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_climb_m  DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_hours    DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_calories INT,               -- NULL = rider has not set a weight yet
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, year)
);

-- The leaderboard's own query pattern: "top N for this year and country, by this column".
-- Not created yet — this table starts empty and today's rider count is tiny (EXPLAIN a plain
-- sequential scan first; add this once real data and real load justify it):
--   CREATE INDEX idx_rider_stats_cache_leaderboard ON rider_stats_cache (year, country);

-- Verify afterwards:
--   SELECT COUNT(*) FROM rider_stats_cache;  -- 0 right after this runs
