-- 039-rider-period-stats.sql — per-rider, per-MONTH and per-YEAR Statistics totals, plus the
-- switch that decides what "did the ride" means.
--
-- WHY THIS TABLE EXISTS
--   The Statistics timeline (client /stats/achievements) shows one block per calendar month and
--   per calendar year. rider_stats_cache (sql/035) only knows "lifetime" and "year" and refreshes
--   every row on the same 24h clock, which is wrong for a timeline: a month that ended last spring
--   can never change again and should not be recomputed daily, while THIS month/year must stay
--   live. This table holds both period types with the finality rule below.
--
-- THIS IS A CACHE, NOT A SOURCE OF TRUTH.
--   Same rule as sql/035: event_participants / events / participant_tracks remain the only
--   authoritative data. Every row here can be deleted and rebuilt with no data loss.
--
-- SHAPE
--   period_type  'month' | 'year'
--   period       'YYYY-MM' for a month, 'YYYY' for a year (UTC calendar, matching
--                events.finished_at::timestamptz AT TIME ZONE 'UTC' in statistics.queries.ts)
--   rides / total_km / total_climb_m / total_hours / total_calories
--                same meaning as rider_stats_cache; total_calories is NULL until the rider has set
--                users.weight_kg (sql/034) — never a number built on a guessed weight
--   computed_at  when the row was last built
--
-- FRESHNESS (enforced in statistics.service.ts, not by the database)
--   current month / current year  trusted for 24 hours, then rebuilt from the raw tables
--   a period that has ended       FINAL once computed_at is on/after the period's end, and never
--                                 rebuilt again. A row computed BEFORE its period ended (e.g. the
--                                 August row last read on 31 Aug) is rebuilt exactly once more.
--   A ride that finishes rebuilds the rider's month + year rows immediately (the finish hook), so
--   the 24h window is only the fallback for a missed invalidation.
--
-- ONE CONSEQUENCE TO KNOW ABOUT
--   A final row is a snapshot: if a rider later changes their weight, their OLD months keep the
--   calories they were saved with. To force a rebuild (e.g. after flipping the flag below):
--     DELETE FROM rider_period_stats;  DELETE FROM rider_stats_cache;
--
-- THE FLAG THIS FILE SEEDS  (app_flags, sql/029)
--   stats_require_live_checkin — 'false' (default): every approved/registered participant of a
--     finished ride counts it. 'true': only a rider recorded as having TURNED UP counts it, i.e.
--     event_participants.attendance_status 'present' or 'started'. That column is the app's one
--     definition of "arrived": it is set by auto check-in (sql/040 — the rider's own GPS near the
--     route start, inside the window around the start time, i.e. "clicked live at the place around
--     the start time") or by the organizer ticking the rider off by hand.
--     ⚠ Turn it on only once auto check-in (sql/040 + the app) is live, or your riders will only
--     count when an organizer ticks them manually and most rides will read as empty:
--       UPDATE app_flags SET value = 'true', updated_at = NOW() WHERE key = 'stats_require_live_checkin';
--     ⚠ PROSPECTIVE ONLY (sql/044): the requirement applies only to rides that started at/after
--     app_flags 'stats_live_checkin_from'; earlier rides keep counting on registration. With no
--     instant set the requirement is not applied at all. Set both, see sql/044.
--     Takes effect within the app_flags read cache (30s) for NEW computations; already-final
--     rows keep the old rule until you run the DELETEs above.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/039-rider-period-stats.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: a new table that starts empty, plus one
-- INSERT ... ON CONFLICT DO NOTHING. Requires sql/029 (app_flags) — if that table is missing the
-- statistics reader treats the flag as off, so the server still works; run 029 first to seed it.

CREATE TABLE IF NOT EXISTS rider_period_stats (
    user_id        BIGINT NOT NULL,          -- no FK, per the house rule in sql/README.md
    period_type    VARCHAR(5) NOT NULL,      -- 'month' | 'year'
    period         VARCHAR(7) NOT NULL,      -- 'YYYY-MM' | 'YYYY'
    rides_count    INT NOT NULL DEFAULT 0,
    total_km       DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_climb_m  DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_hours    DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_calories INT,                      -- NULL = rider has not set a weight yet
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, period_type, period),
    CONSTRAINT rider_period_stats_type_chk CHECK (period_type IN ('month', 'year'))
);

INSERT INTO app_flags (key, value, note, updated_at)
VALUES (
    'stats_require_live_checkin',
    'false',
    'Statistics: when true, a ride only counts for a rider marked as turned up (attendance_status present/started — auto check-in or organizer tick). When false, every registered/approved participant counts. Rebuild caches after flipping — see sql/039.',
    NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Verify afterwards:
--   SELECT COUNT(*) FROM rider_period_stats;                                 -- 0 right after this runs
--   SELECT key, value FROM app_flags WHERE key = 'stats_require_live_checkin';  -- 'false'
