-- ⚠ MERGE NOTE (2026-08-31). A parallel branch marked this file "SUPERSEDED BY
-- sql/020-user-entitlements.sql — do not apply. This table was never created on any database."
-- That is no longer true. `user_limits` EXISTS IN PRODUCTION with a row for every user, and
-- sql/019 has been applied to it. The user_entitlements model was not adopted; this one was.
-- Do not re-mark this file superseded.
--
-- 018-user-limits.sql — per-user limits. THE single runtime source of truth for what one
-- person may do.
--
-- WHY THIS TABLE EXISTS
--   Limits used to be resolved per request from config + plans + an optional override, which
--   meant the number a rider hit was assembled in code and existed nowhere you could look at
--   it. Worse, every layer had a fallback, so this table not existing at all was invisible:
--   everyone silently resolved to the free tier and the product looked like it worked.
--
--   Now the row IS the answer. Authorization reads it and nothing else.
--
-- EVERY COLUMN IS NOT NULL, and that is the important part.
--   There is no "inherit" state. A row always carries real numbers, written once at signup
--   from the DEFAULT_* environment values (src/config/plan-limits.ts) and thereafter changed
--   only by an explicit UPDATE — by support, or by the plan-grant sync. Changing the config
--   defaults does NOT move an existing user; that is a deliberate property, not an oversight.
--
--   effective limit = user_limits.<column>          always
--   no row          = UserLimitsNotFoundError       never a default
--
-- WHERE ROWS COME FROM
--   new users        insertUserLimitsTx(), in the same transaction as the user
--   existing users   sql/019-user-limits-backfill.sql
--   plan changes     syncUserLimitsFromGrantsTx(), in the same transaction as the grant
--
-- NOT A USAGE COUNTER. This table records what a user MAY do. What they HAVE done is counted
-- from the real tables (events, event_participants, event_groups, teams) at check time, so a
-- counter can never drift from reality.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/018-user-limits.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/019-user-limits-backfill.sql   <- REQUIRED
--
--   ⚠ 018 ALONE IS NOT ENOUGH. An empty table means every existing user now fails
--   authorization instead of falling back. Run 019 in the same maintenance window.
--
-- SAFE ON LIVE DATA and safe to run more than once. No foreign key, per the house rule in
-- sql/README.md — the application owns the relationship.

CREATE TABLE IF NOT EXISTS user_limits (
    user_id                BIGINT PRIMARY KEY,   -- one row per user; no FK by house rule
    events_per_week        INT NOT NULL,
    participants_per_event INT NOT NULL,
    groups_per_event       INT NOT NULL,
    teams_owned            INT NOT NULL,
    /** Why this user has these numbers — "created with user", "plan:organizer_pro", or a
        support note / ticket id. Never a price and never a payment identifier: billing writes
        entitlement_grants, not this. */
    note                   TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A limit is a count, so a negative one is always a mistake. 0 is legitimate — it means "may
-- create none" — so this is >= 0, not > 0.
-- ADD CONSTRAINT has no IF NOT EXISTS, so it is guarded to keep this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_limits_non_negative'
    ) THEN
        ALTER TABLE user_limits
            ADD CONSTRAINT user_limits_non_negative
            CHECK (
                events_per_week        >= 0 AND
                participants_per_event >= 0 AND
                groups_per_event       >= 0 AND
                teams_owned            >= 0
            );
    END IF;
END $$;

-- No index beyond the primary key: the only query is a lookup by user_id, once per request,
-- which the PK already serves.
