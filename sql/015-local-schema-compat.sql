-- 015-local-schema-compat.sql
-- Purpose:
--   One-shot, idempotent compatibility patch for local databases that are behind
--   current server expectations.
--
-- Fixes known runtime errors:
--   - missing events profile columns (activity_type, level, organizer_group)
--   - missing authz table (entitlement_grants)
--   - missing teams tables used by /users/me usage counters
--
-- Safe to run multiple times.

BEGIN;

-- -----------------------------------------------------------------------------
-- Events profile (create/list filters)
-- -----------------------------------------------------------------------------
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS activity_type   VARCHAR(30),
    ADD COLUMN IF NOT EXISTS level           VARCHAR(30),
    ADD COLUMN IF NOT EXISTS organizer_group VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_events_public_browse
    ON events (activity_type, level)
    WHERE visibility = 'public';

-- -----------------------------------------------------------------------------
-- Teams domain (used by account usage and teams features)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    owner_id    BIGINT NOT NULL,
    avatar_url  VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id);

CREATE TABLE IF NOT EXISTS team_members (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id    BIGINT NOT NULL,
    user_id    BIGINT,
    name       VARCHAR(200),
    email      VARCHAR(255),
    phone      VARCHAR(100),
    status     VARCHAR(30) NOT NULL DEFAULT 'invited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_id_user_id_key
    ON team_members (team_id, user_id);

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS team_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_events_team ON events (team_id) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_follows (
    follower_id BIGINT NOT NULL,
    followee_id BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows (followee_id);

-- -----------------------------------------------------------------------------
-- Authorization entitlements (used on /users/me and authz resolution)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlement_grants (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    plan_code   VARCHAR(50),
    feature     VARCHAR(50),
    quantity    INT,
    consumed    INT NOT NULL DEFAULT 0,
    scope_type  VARCHAR(30),
    scope_id    VARCHAR(64),
    source      VARCHAR(30) NOT NULL,
    source_ref  VARCHAR(160),
    starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT entitlement_grants_one_of_plan_or_feature
        CHECK ((plan_code IS NULL) <> (feature IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_entitlement_grants_user_live
    ON entitlement_grants (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entitlement_grants_source
    ON entitlement_grants (source, source_ref);

-- Visibility value docs and owner membership backfill from auth migration.
COMMENT ON COLUMN events.visibility IS 'public | registered | private — see AUTHORIZATION.md';

INSERT INTO event_members (event_id, user_id, role)
SELECT e.id, e.owner_id, 'owner'
  FROM events e
 WHERE e.owner_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM event_members m WHERE m.event_id = e.id AND m.user_id = e.owner_id
   );

COMMIT;
