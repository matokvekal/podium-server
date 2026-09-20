-- 044-stats-history-backfill.sql — what the one-time Statistics history backfill needs.
--
--   users.stats_backfill_excluded  BOOLEAN NOT NULL DEFAULT FALSE
--   app_flags 'stats_live_checkin_from'   (seeded empty = unset)
--
-- WHY THE BACKFILL EXISTS
--   rider_period_stats (sql/039) is filled by the ride-finish hook, so it only knows rides that
--   finish AFTER the Statistics feature ships. Every rider's past rides would read as an empty
--   history. `npm run stats:backfill` (src/statistics/statistics.backfill*.ts) rebuilds every
--   rider's month/year rows from their real past participation, with the SAME calculation the
--   live system uses. This file is the two small pieces of schema/config it relies on.
--
-- 1. EXCLUDING AN ACCOUNT FROM THE BACKFILL
--   No usable flag existed: users.is_active means "may sign in" (a deactivated rider is a real
--   rider with real history), users.role is RIDER | COMMISSAIRE. So one dedicated column.
--   TRUE = the backfill skips this account entirely (writes nothing for it, reports it as
--   excluded). Use it for test / demo / staff accounts:
--       UPDATE users SET stats_backfill_excluded = TRUE WHERE id IN (...);
--   It gates ONLY the backfill. It does not hide the rider from live Statistics or the
--   leaderboard — that is a separate product decision, deliberately not made here.
--
-- 2. THE CHECK-IN RULE IS PROSPECTIVE (app_flags 'stats_live_checkin_from')
--   'stats_require_live_checkin' (sql/039) used to mean "EVERY ride needs attendance_status
--   present". Auto check-in did not exist for historical rides, so turning that on would have
--   erased every rider's real history the next time a month was recomputed — including the
--   backfilled rows. Now the requirement only applies to rides that STARTED at or after the
--   instant stored here:
--       UPDATE app_flags SET value = '2026-10-01T00:00:00Z', updated_at = NOW()
--        WHERE key = 'stats_live_checkin_from';
--   Rides that started earlier keep counting on registration alone, whatever their attendance.
--   Both flags must be set for the requirement to apply. If 'stats_require_live_checkin' is on
--   but this one is empty/unparseable the requirement is NOT applied (a warning is logged): the
--   safe direction is "keep history", never "silently drop it".
--   As before, flipping either flag does not rewrite settled rows; rebuild with the deletes
--   in sql/039 or re-run the backfill.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/044-stats-history-backfill.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN with a constant default is
-- metadata-only in PostgreSQL 11+ (no rewrite, no long lock); the flag insert is
-- ON CONFLICT DO NOTHING. Requires sql/029 (app_flags).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS stats_backfill_excluded BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.stats_backfill_excluded IS
    'TRUE = the Statistics history backfill skips this account (test/demo/staff). Backfill only; live Statistics is unaffected.';

INSERT INTO app_flags (key, value, note, updated_at)
VALUES (
    'stats_live_checkin_from',
    '',
    'Statistics: ISO-8601 instant. With stats_require_live_checkin = true, only rides that started at/after this instant need an attendance check-in; earlier rides count on registration alone. Empty = the check-in requirement is not applied. See sql/044.',
    NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Verify afterwards:
--   SELECT COUNT(*) FILTER (WHERE stats_backfill_excluded) AS excluded, COUNT(*) FROM users;  -- 0 excluded
--   SELECT key, value FROM app_flags WHERE key = 'stats_live_checkin_from';                    -- ''
