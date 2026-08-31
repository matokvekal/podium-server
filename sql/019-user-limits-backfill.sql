-- 019-user-limits-backfill.sql — give every EXISTING user a user_limits row, and convert any
-- pre-existing nullable table to the NOT NULL shape 018 now defines.
--
-- ⚠ THIS FILE IS REQUIRED, NOT OPTIONAL.
--   Authorization throws UserLimitsNotFoundError for a user with no row — there is no fallback
--   any more, on purpose. Between running 018 and running this, every existing user is locked
--   out of anything that checks a limit. Run them together, in one maintenance window.
--
-- SAFE AND RE-RUNNABLE. It never overwrites a row that already exists: WHERE NOT EXISTS on the
-- insert, and the null-fill below only touches columns that are actually NULL. A support
-- override of 20 set before this runs still says 20 afterwards.
--
-- DEFAULT VALUES
--   These MUST match the DEFAULT_* environment values the server is running with, or a user
--   created before the backfill gets different numbers from one created after it. The server's
--   values are DEFAULT_EVENTS_PER_WEEK / _PARTICIPANTS_PER_EVENT / _GROUPS_PER_EVENT /
--   _TEAMS_OWNED, whose own defaults are 3 / 50 / 2 / 2 (src/config/env.ts).
--
--   Override without editing this file:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -v events_per_week=3 -v participants_per_event=50 \
--          -v groups_per_event=2 -v teams_owned=2 \
--          -f sql/019-user-limits-backfill.sql
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/018-user-limits.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/019-user-limits-backfill.sql

\if :{?events_per_week}        \else \set events_per_week        3  \endif
\if :{?participants_per_event} \else \set participants_per_event 50 \endif
\if :{?groups_per_event}       \else \set groups_per_event       2  \endif
\if :{?teams_owned}            \else \set teams_owned            2  \endif

BEGIN;

-- ---- 1. converge an older 018 -------------------------------------------------------------
-- An environment that ran the previous nullable version of 018 has NULLs meaning "inherit".
-- Those become real values here. A no-op on a table created by the current 018.
UPDATE user_limits SET
    events_per_week        = COALESCE(events_per_week,        :events_per_week),
    participants_per_event = COALESCE(participants_per_event, :participants_per_event),
    groups_per_event       = COALESCE(groups_per_event,       :groups_per_event),
    teams_owned            = COALESCE(teams_owned,            :teams_owned),
    updated_at             = NOW()
 WHERE events_per_week        IS NULL
    OR participants_per_event IS NULL
    OR groups_per_event       IS NULL
    OR teams_owned            IS NULL;

-- ---- 2. the backfill ----------------------------------------------------------------------
-- WHERE NOT EXISTS, not ON CONFLICT DO UPDATE: a user who already has a row keeps every value
-- in it, including a support override that differs from the defaults.
INSERT INTO user_limits (
    user_id,
    events_per_week,
    participants_per_event,
    groups_per_event,
    teams_owned,
    note
)
SELECT
    u.id,
    :events_per_week,
    :participants_per_event,
    :groups_per_event,
    :teams_owned,
    'backfilled by sql/019'
  FROM users u
 WHERE NOT EXISTS (
     SELECT 1 FROM user_limits ul WHERE ul.user_id = u.id
 );

-- ---- 3. enforce the shape -----------------------------------------------------------------
-- Only reachable once steps 1 and 2 have left no NULLs. SET NOT NULL is a no-op when the
-- column already is, so this is re-runnable.
ALTER TABLE user_limits
    ALTER COLUMN events_per_week        SET NOT NULL,
    ALTER COLUMN participants_per_event SET NOT NULL,
    ALTER COLUMN groups_per_event       SET NOT NULL,
    ALTER COLUMN teams_owned            SET NOT NULL;

-- ---- 4. prove it before committing --------------------------------------------------------
-- A user with no row cannot authorize, so leaving even one behind is an outage for that
-- person. Refuse to commit rather than report success on a partial backfill.
DO $$
DECLARE
    missing BIGINT;
BEGIN
    SELECT count(*) INTO missing
      FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_limits ul WHERE ul.user_id = u.id);

    IF missing > 0 THEN
        RAISE EXCEPTION 'backfill incomplete: % users still have no user_limits row', missing;
    END IF;
END $$;

COMMIT;

-- Verify afterwards:
--   SELECT count(*) FROM users;
--   SELECT count(*) FROM user_limits;
--   SELECT note, count(*) FROM user_limits GROUP BY note ORDER BY 2 DESC;
