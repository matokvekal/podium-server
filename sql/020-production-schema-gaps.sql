-- 020-production-schema-gaps.sql — the pieces of 011 and 014 that were never applied to the
-- production database (191.215.39.19/elnino).
--
-- WHY A SEPARATE FILE RATHER THAN RE-RUNNING 011 AND 014
--   Because only part of 014 is missing. A schema introspection on 2026-08-31 found:
--
--     011-client-action-results   NOT APPLIED   client_actions.response_status / response_body
--     014-authorization           PARTIAL       entitlement_grants EXISTS,
--                                               coupons + coupon_redemptions MISSING
--     018-user-limits             NOT APPLIED   (see 018 + 019, run those too)
--
--   014 looks applied if you check for entitlement_grants alone, because
--   sql/015-local-schema-compat.sql creates that table and NOT the two coupon tables — the
--   trap already noted at sql/016-schema-sync.sql:263. This file states the gap explicitly so
--   the next person does not have to rediscover it.
--
--   Everything here is also in 016-schema-sync.sql. 016 is a broad convergence file that
--   touches most of the schema; this is the narrow subset that production actually lacks, so
--   it can be read in full before it is run. Running 016 instead would work and would do more.
--
-- WHAT WAS BROKEN WHILE THESE WERE MISSING
--   011  Degraded silently. Both call sites are wrapped (src/middleware/clientActions.ts:77
--        and :118), so nothing crashed — but every completed action logged "failed to record
--        client action result", and a de-duplicated retry answered `data: null` instead of the
--        original response body.
--   014  POST /users/me/redeem returned 500. It is a live route (src/routes/user.routes.ts:47)
--        and redeemCoupon goes straight to `SELECT * FROM coupons` with no fallback.
--
-- SAFE ON LIVE DATA and re-runnable: every statement is additive and IF NOT EXISTS guarded.
-- No column is dropped, renamed, retyped or backfilled, so there is nothing here that can
-- destroy or rewrite existing rows.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/020-production-schema-gaps.sql

BEGIN;

-- ---- from 011-client-action-results.sql ---------------------------------------------------
-- Without these, a replayed offline action hands the rider `undefined` instead of the original
-- result: the client's apiMutate reads body.data out of the 409 and treats it as the return.
ALTER TABLE client_actions
    ADD COLUMN IF NOT EXISTS response_status INT,
    ADD COLUMN IF NOT EXISTS response_body   JSONB;

-- ---- from 014-authorization.sql (the coupon half only) ------------------------------------
-- entitlement_grants already exists in production and is NOT touched here.
CREATE TABLE IF NOT EXISTS coupons (
    code            VARCHAR(64) PRIMARY KEY,   -- stored uppercase; compared uppercase

    -- What redeeming it grants — the same either/or as a grant.
    plan_code       VARCHAR(50),
    feature         VARCHAR(50),
    quantity        INT,                       -- for a coupon that grants consumable credits

    -- How long the GRANT lasts. Exactly one, or neither for a grant that never expires.
    grant_days      INT,                       -- N days from the moment it is redeemed
    grant_until     TIMESTAMPTZ,               -- ...or a fixed date, whenever it is redeemed

    max_redemptions INT,                       -- NULL = unlimited
    redeemed_count  INT NOT NULL DEFAULT 0,

    -- When the COUPON works, as opposed to how long the grant lasts. Two different clocks.
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMPTZ,

    note            TEXT,                      -- "beta wave 2", "cycling club partnership"
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT coupons_one_of_plan_or_feature
        CHECK ((plan_code IS NULL) <> (feature IS NULL)),
    CONSTRAINT coupons_one_grant_window
        CHECK (grant_days IS NULL OR grant_until IS NULL)
);

-- One redemption per person per coupon, enforced by the key rather than by a check that can
-- lose a race.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
    coupon_code VARCHAR(64) NOT NULL,
    user_id     BIGINT NOT NULL,
    grant_id    BIGINT,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (coupon_code, user_id)
);

-- "Who redeemed this campaign" — the only question asked of this table that the key cannot
-- already answer.
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon
    ON coupon_redemptions (coupon_code, redeemed_at DESC);

COMMIT;

-- Verify afterwards:
--   \d client_actions
--   \d coupons
--   \d coupon_redemptions
