-- 018-user-limits.sql — per-user effective limits, so one person can be upgraded without a
-- code deploy.
--
-- WHY THIS TABLE EXISTS
--   Limits come from PLANS in src/authz/plans.ts, whose free tier reads the single default
--   config in src/config/plan-limits.ts. That is right for product-wide decisions and wrong
--   for "give THIS organizer 20 events a week": today that needs an entitlement_grants row
--   for a whole plan tier, or a deploy. This table is the per-user override.
--
-- NULL MEANS INHERIT, and that is the important part.
--   A NULL column is not "zero" and not "the default" — it means "whatever this user's plan
--   says", resolved in code. So a row may override one limit and leave the rest alone, and
--   changing DEFAULT_PLAN_LIMITS in code still moves every user who has not been given an
--   explicit number. Writing literal defaults into every row would freeze today's numbers
--   into the data and silently demote anyone holding a paid plan grant.
--
--   effective limit = user_limits.<column>  when NOT NULL
--                     otherwise the plan limit (free plan = DEFAULT_PLAN_LIMITS)
--
--   no row at all   = the same as a row of all NULLs
--
-- NOT A USAGE COUNTER. This table records what a user MAY do. What they HAVE done is counted
-- from the real tables (events, event_participants, event_groups, teams) at check time, so a
-- counter can never drift from reality.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/018-user-limits.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. Creating a table nothing yet has rows in
-- changes no existing behaviour: with no row, every user resolves exactly as they do today.
-- No foreign key, per the house rule in sql/README.md — the application owns the relationship.

CREATE TABLE IF NOT EXISTS user_limits (
    user_id              BIGINT PRIMARY KEY,   -- one row per user; no FK by house rule
    events_per_week      INT,                  -- NULL = inherit from the user's plan
    participants_per_event INT,
    groups_per_event     INT,
    teams_owned          INT,
    /** Why this user has an override — support note, coupon reference, ticket id. Never a
        price and never a payment identifier: billing writes entitlement_grants, not this. */
    note                 TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A limit is a count, so a negative one is always a mistake. NULL passes a CHECK, which is
-- exactly what we want: it is the inherit case, not a value.
-- ADD CONSTRAINT has no IF NOT EXISTS, so it is guarded to keep this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_limits_non_negative'
    ) THEN
        ALTER TABLE user_limits
            ADD CONSTRAINT user_limits_non_negative
            CHECK (
                (events_per_week        IS NULL OR events_per_week        >= 0) AND
                (participants_per_event IS NULL OR participants_per_event >= 0) AND
                (groups_per_event       IS NULL OR groups_per_event       >= 0) AND
                (teams_owned            IS NULL OR teams_owned            >= 0)
            );
    END IF;
END $$;

-- No index beyond the primary key: the only query is a lookup by user_id, once per request,
-- which the PK already serves.
