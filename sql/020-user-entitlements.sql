-- ⚠ NOT ADOPTED (merge decision, 2026-08-31). This file is kept for history and is NOT part
-- of the migration path. Do not apply it.
--
-- It models per-user limits as `user_entitlements` with a runtime `override ?? plan ?? default`
-- fallback chain. The project went the other way: `user_limits` (sql/018 + sql/019) is the
-- single runtime source of truth, with NO fallback — a user with no row raises
-- UserLimitsNotFoundError. `user_limits` is live in production with a row for every user;
-- `user_entitlements` was never created there.
--
-- What DID survive from this branch: the max* field naming (maxEventsPerWeek, …), which the
-- rest of the codebase reads.
--
-- 020-user-entitlements.sql — the per-user entitlement / limits model, so one person can be
-- given custom limits without a code deploy.
--
-- WHY THIS TABLE EXISTS
--   Limits come from PLANS in src/authz/plans.ts, whose free tier reads the single default
--   config in src/config/plan-limits.ts (DEFAULT_PLAN_LIMITS = 3 / 50 / 2). That is right for
--   product-wide decisions and wrong for "give THIS organizer 200 riders a ride": today that
--   needs an entitlement_grants row for a whole plan tier, or a deploy. This table is the
--   per-user override, and it is now the authoritative store the server resolves limits from.
--
--   effective limit = user_entitlements.<column>   when the user has a row
--                     otherwise the plan limit (free plan = DEFAULT_PLAN_LIMITS)
--
--   NO ROW = the code defaults apply. Every existing user already effectively has 3 / 50 / 2,
--   so creating this table with nothing in it changes no behaviour. A per-user override is
--   simply this row written with different values; there is no HTTP route, it is written from
--   psql or a billing/support script (see upsertUserEntitlements).
--
-- NOT A USAGE COUNTER. This table records what a user MAY do. What they HAVE done is counted
-- from the real domain tables (events, event_participants, event_groups) at check time, so a
-- stored counter can never drift from reality.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/020-user-entitlements.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. No foreign key, per the house rule in
-- sql/README.md — the application owns the relationship.
--
-- SUPERSEDES sql/018-user-limits.sql, which was never applied to any database. 018's NULL-means-
-- inherit, per-column model is replaced here by "no row = defaults, a row = an explicit set of
-- values"; the three limits that vary in practice each get a NOT NULL column with the default
-- baked in.

CREATE TABLE IF NOT EXISTS user_entitlements (
    user_id                    BIGINT PRIMARY KEY,   -- one row per user; FK-free per house rule
    max_events_per_week        INT NOT NULL DEFAULT 3,
    max_participants_per_event INT NOT NULL DEFAULT 50,
    max_groups_per_event       INT NOT NULL DEFAULT 2,
    -- Why this user has an override — support note, coupon reference, ticket id. Never a price
    -- and never a payment identifier: billing writes entitlement_grants, not this.
    note                       TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A limit is a count, so a negative one is always a mistake. ADD CONSTRAINT has no
-- IF NOT EXISTS, so it is guarded to keep this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_entitlements_non_negative'
    ) THEN
        ALTER TABLE user_entitlements
            ADD CONSTRAINT user_entitlements_non_negative
            CHECK (
                max_events_per_week        >= 0 AND
                max_participants_per_event >= 0 AND
                max_groups_per_event       >= 0
            );
    END IF;
END $$;

-- No index beyond the primary key: the only query is a lookup by user_id, once per request,
-- which the PK already serves.
