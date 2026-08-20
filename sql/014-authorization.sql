-- 014-authorization.sql — the data model behind AUTHORIZATION.md.
--
-- Three separate concerns, deliberately not merged into one "premium" column:
--   * event visibility gains a third value                (layer 5)
--   * event ownership becomes a real event_members row    (layer 3)
--   * entitlements, coupons and redemptions               (layer 4)
--
-- No price, product name or billing identifier appears here. A grant records WHAT a user has
-- and FOR HOW LONG; what it cost and who was invoiced is a billing concern that will write
-- these rows and read nothing.
--
-- Safe to run on the live database: every statement is additive or a backfill.

-- ---------------------------------------------------------------------------------------
-- Layer 5 — visibility
-- ---------------------------------------------------------------------------------------
-- events.visibility is already VARCHAR, so 'registered' needs no DDL: public | registered |
-- private. Recorded here because the column comment in 002 lists only two values.
--
--   public      anyone, including a signed-out guest
--   registered  any signed-in user  (NEW)
--   private     only someone with a participation row or an event role; 404 to everyone else
COMMENT ON COLUMN events.visibility IS 'public | registered | private — see AUTHORIZATION.md';

-- ---------------------------------------------------------------------------------------
-- Layer 3 — event roles
-- ---------------------------------------------------------------------------------------
-- event_members has existed since 002 and nothing has ever read it. The owner row is now
-- written at creation; this backfills every event that predates that.
--
-- "A user who created an event gets admin permissions for that event only, not globally" —
-- which is exactly what a row keyed on (event_id, user_id) expresses and a global role cannot.
INSERT INTO event_members (event_id, user_id, role)
SELECT e.id, e.owner_id, 'owner'
  FROM events e
 WHERE e.owner_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM event_members m WHERE m.event_id = e.id AND m.user_id = e.owner_id
   );

-- ---------------------------------------------------------------------------------------
-- Layer 4 — entitlements
-- ---------------------------------------------------------------------------------------
-- One row per "this user has X, from this source, during this window". A grant confers
-- EITHER a whole plan OR a single feature — never both, so that resolution never has to
-- guess which one was meant.
CREATE TABLE IF NOT EXISTS entitlement_grants (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL,

    -- Exactly one of these two is set. plan_code matches a definition in authz/plans.ts;
    -- it is text, not an enum, so a new tier is a code change and not a migration.
    plan_code   VARCHAR(50),
    feature     VARCHAR(50),

    -- Consumable grants — the one-time "private event" purchase. NULL quantity means the
    -- grant is not consumable and applies for its whole window.
    quantity    INT,
    consumed    INT NOT NULL DEFAULT 0,

    -- NULL scope = account-wide. 'event' scopes a grant to a single ride, which is how a
    -- one-time purchase stays attached to the thing it paid for.
    scope_type  VARCHAR(30),
    scope_id    VARCHAR(64),

    -- Where it came from. Kept for support and refunds, never read by the policy.
    source      VARCHAR(30) NOT NULL,   -- subscription | coupon | purchase | trial | manual
    source_ref  VARCHAR(160),           -- provider id, coupon code, support ticket

    starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,            -- NULL = no expiry
    -- Revoked rather than deleted: a refund must not erase the fact that access was granted.
    revoked_at  TIMESTAMPTZ,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT entitlement_grants_one_of_plan_or_feature
        CHECK ((plan_code IS NULL) <> (feature IS NULL))
);

-- The hot path: every live grant for one user, on every authenticated request.
CREATE INDEX IF NOT EXISTS idx_entitlement_grants_user_live
    ON entitlement_grants (user_id, expires_at)
    WHERE revoked_at IS NULL;

-- Support: "what did we give this person, and where did it come from".
CREATE INDEX IF NOT EXISTS idx_entitlement_grants_source
    ON entitlement_grants (source, source_ref);

-- ---------------------------------------------------------------------------------------
-- Coupons — the beta plan depends on these
-- ---------------------------------------------------------------------------------------
-- "During the early/beta period we will use many free Premium coupons with expiration dates."
-- Handing out Pro for 90 days is one row here.
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
