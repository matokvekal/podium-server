-- 033-user-limits-concurrent-live-events.sql — the real per-user cap on simultaneous live rides.
--
-- THE BUG THIS FIXES
--   sql/010-drop-one-live-per-owner.sql dropped the unique index that hard-capped an owner at
--   one live event, on the stated plan that "up to N (currently 2) simultaneous live events per
--   owner" would move to a count-based check in event.service.ts's changeEventStatus. That check
--   was never written — changeEventStatus still refuses a SECOND live event outright via
--   selectLiveEventForOwner (LIMIT 1), so MAX_CONCURRENT_LIVE_EVENTS_FREE (env.ts, default 2)
--   has never had any effect. An organizer allowed 2 hits a 409 on their 2nd.
--
-- WHAT THIS ADDS
--   user_limits.concurrent_live_events — same shape and same rules as every other column on
--   this table (018-user-limits.sql): NOT NULL, no fallback, changed only by an explicit
--   UPDATE (support, or a future plan grant). The runtime check moves from "does any live event
--   exist" to "how many, compared to this owner's own number".
--
-- BACKFILL
--   DEFAULT 1 on the ALTER — every existing row gets exactly the limit already being enforced
--   today, so deploying this changes nothing for anyone until a row is explicitly raised:
--     UPDATE user_limits SET concurrent_live_events = 2 WHERE user_id = 123;
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code before or after this file. Before this runs,
--   selectUserLimitsOrThrow simply does not see the column — the server reads named columns via
--   SELECT_COLUMNS (userLimits.queries.ts), so an absent column fails that one query with a
--   real Postgres error rather than silently omitting the field. Run this first in the same
--   maintenance window as the code that reads it, same as sql/018+019 had to land together.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/033-user-limits-concurrent-live-events.sql
--
-- SAFE ON LIVE DATA and safe to run more than once.

ALTER TABLE user_limits
    ADD COLUMN IF NOT EXISTS concurrent_live_events INT NOT NULL DEFAULT 1;

-- A limit is a count, so a negative one is always a mistake; kept as its own constraint rather
-- than folded into user_limits_non_negative (018) so this file does not have to DROP/re-ADD a
-- constraint it does not own.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_limits_concurrent_live_events_non_negative'
    ) THEN
        ALTER TABLE user_limits
            ADD CONSTRAINT user_limits_concurrent_live_events_non_negative
            CHECK (concurrent_live_events >= 0);
    END IF;
END $$;

-- Verify afterwards:
--   SELECT user_id, concurrent_live_events FROM user_limits ORDER BY user_id;
--   -- every row should show 1 until deliberately raised
