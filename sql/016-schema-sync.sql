-- 016-schema-sync.sql — bring any existing database up to what the current server code needs.
--
-- WHY THIS FILE EXISTS
--   sql/README.md's run-order for the live (Prisma-created) database predates three files and
--   never lists them, so a database set up by following it is missing:
--
--     * events.area                        (009-events-area.sql)   -> POST /api/v1/events 500s
--                                                                     with 42703 "column area
--                                                                     of relation events does
--                                                                     not exist"
--     * entitlement_grants / coupons /     (014-authorization.sql) -> buildActor() runs on the
--       coupon_redemptions                                           create, detail, participants,
--                                                                     groups and teams paths and
--                                                                     reads entitlement_grants on
--                                                                     every one of them
--     * idx_events_one_live_per_owner      (010-drop-one-live-per-owner.sql)
--       is still PRESENT and must be dropped -> the server now allows N concurrent live events
--       per owner (MAX_CONCURRENT_LIVE_EVENTS_FREE, default 2); the old unique index can only
--       express "at most 1" and raises a unique violation on the second one.
--
--   Every other column the server references does exist somewhere in sql/. This file is the
--   union of 002-014 in additive, re-runnable form, so it is safe whichever of those a given
--   database has already had applied.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/016-schema-sync.sql
--
-- SAFE TO RUN MORE THAN ONCE. Every statement is IF NOT EXISTS / IF EXISTS or a no-op repeat.
-- Sections A and B are additive only. Section C changes data and is marked separately —
-- read it before running it.
--
-- NOT INCLUDED ON PURPOSE
--   * sql/001-init.sql          — those tables already exist; this file never creates them
--   * sql/900-timestamptz-...   — rewrites existing data, must stay a deliberate manual step
--   * any DROP of a column or table

BEGIN;

-- =======================================================================================
-- SECTION A — columns (additive; ADD COLUMN with a constant DEFAULT is metadata-only in
--             PostgreSQL 11+, so none of these rewrite a table)
-- =======================================================================================

-- ---- events -----------------------------------------------------------------------------
-- From 002-events-podium.sql: ownership, lifecycle, visibility and the six show_* flags.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS owner_id               BIGINT,
    ADD COLUMN IF NOT EXISTS display_mode           VARCHAR(30) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS status                 VARCHAR(30) NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS visibility             VARCHAR(30) NOT NULL DEFAULT 'private',
    ADD COLUMN IF NOT EXISTS description            TEXT,
    ADD COLUMN IF NOT EXISTS location               VARCHAR(255),
    ADD COLUMN IF NOT EXISTS finished_at            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS show_event_info        BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_participants      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_route             BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_live_locations    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_history_locations BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_results           BOOLEAN NOT NULL DEFAULT TRUE,
    -- From 008-registration-and-live.sql.
    ADD COLUMN IF NOT EXISTS requires_approval      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_paused              BOOLEAN NOT NULL DEFAULT FALSE,
    -- ⚠ From 009-events-area.sql — THE ONE THAT BREAKS POST /api/v1/events TODAY.
    -- insertEvent() names `area` in both its main and its legacy-fallback INSERT, so a
    -- database without this column cannot create an event at all.
    ADD COLUMN IF NOT EXISTS area                   VARCHAR(255),
    -- From 010-event-profile.sql.
    ADD COLUMN IF NOT EXISTS activity_type          VARCHAR(30),
    ADD COLUMN IF NOT EXISTS level                  VARCHAR(30),
    ADD COLUMN IF NOT EXISTS organizer_group        VARCHAR(200),
    -- From 013-teams-and-follows.sql.
    ADD COLUMN IF NOT EXISTS team_id                BIGINT;

-- ---- event_participants -------------------------------------------------------------------
-- ⚠ .id is `participantId` in the frozen Android contract. Nothing here touches it.
-- A participant must be allowed to have no account (manual entry, spreadsheet import).
-- Already-nullable is a no-op, not an error.
ALTER TABLE event_participants ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE event_participants
    -- From 003-participants.sql.
    ADD COLUMN IF NOT EXISTS name                VARCHAR(200),
    ADD COLUMN IF NOT EXISTS email               VARCHAR(255),
    ADD COLUMN IF NOT EXISTS phone               VARCHAR(100),
    ADD COLUMN IF NOT EXISTS category            VARCHAR(80),
    ADD COLUMN IF NOT EXISTS registration_status VARCHAR(30) NOT NULL DEFAULT 'registered',
    ADD COLUMN IF NOT EXISTS attendance_status   VARCHAR(30) NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS result_status       VARCHAR(30) NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS finished_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finish_position     INT,
    -- From 009-results.sql.
    ADD COLUMN IF NOT EXISTS team                VARCHAR(120),
    ADD COLUMN IF NOT EXISTS country_code        CHAR(2),
    -- From 012-ride-groups.sql.
    ADD COLUMN IF NOT EXISTS group_id            BIGINT;

-- ---- users / location_points / client_actions ---------------------------------------------
-- From 007-users-avatar.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);

-- From 002-events-podium.sql. Derivable by joining through event_participants, but storing it
-- turns retention cleanup and per-event export into single statements. Backfilled in Section C.
ALTER TABLE location_points ADD COLUMN IF NOT EXISTS event_id UUID;

-- From 011-client-action-results.sql. Without these a replayed offline action answers 409 with
-- `data: null` and the client hands the rider `undefined` instead of the original result.
ALTER TABLE client_actions
    ADD COLUMN IF NOT EXISTS response_status INT,
    ADD COLUMN IF NOT EXISTS response_body   JSONB;

-- =======================================================================================
-- SECTION B — tables and indexes (additive)
-- =======================================================================================

-- ---- event_members (002) ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_members (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id  UUID NOT NULL,
    user_id   BIGINT NOT NULL,
    role      VARCHAR(30) NOT NULL,          -- owner | operator | viewer
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_members_event_id_user_id_key
    ON event_members (event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_members_user  ON event_members (user_id);
CREATE INDEX IF NOT EXISTS idx_event_members_event ON event_members (event_id);

-- ---- routes / event_routes (004) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id       BIGINT,
    name           VARCHAR(255),
    route_type     VARCHAR(50),
    source         VARCHAR(50),
    distance_km    DOUBLE PRECISION,
    elevation_m    DOUBLE PRECISION,
    track_points   JSONB,
    markers        JSONB,
    preview_points JSONB,
    point_count    INT,
    is_public      BOOLEAN NOT NULL DEFAULT FALSE,
    place_name     VARCHAR(255),
    start_lat      DOUBLE PRECISION,
    start_lon      DOUBLE PRECISION,
    end_lat        DOUBLE PRECISION,
    end_lon        DOUBLE PRECISION,
    bbox_min_lat   DOUBLE PRECISION,
    bbox_min_lon   DOUBLE PRECISION,
    bbox_max_lat   DOUBLE PRECISION,
    bbox_max_lon   DOUBLE PRECISION,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes (owner_id);
CREATE INDEX IF NOT EXISTS idx_routes_public
    ON routes (is_public, created_at DESC) WHERE is_public = TRUE;
CREATE INDEX IF NOT EXISTS idx_routes_public_start
    ON routes (start_lat, start_lon) WHERE is_public = TRUE;

CREATE TABLE IF NOT EXISTS event_routes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   UUID NOT NULL,
    route_id   BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_routes_event ON event_routes (event_id);

-- ---- tracking (005) -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participant_last_location (
    event_id              UUID NOT NULL,
    participant_id        BIGINT NOT NULL,
    recorded_at           TIMESTAMPTZ,
    lat                   DOUBLE PRECISION,
    lng                   DOUBLE PRECISION,
    accuracy              DOUBLE PRECISION,
    emergency             BOOLEAN NOT NULL DEFAULT FALSE,
    distance_travelled_km DOUBLE PRECISION,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, participant_id)
);

CREATE TABLE IF NOT EXISTS participant_tracks (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id       UUID NOT NULL,
    participant_id BIGINT NOT NULL,
    points         JSONB,
    point_count    INT,
    distance_km    DOUBLE PRECISION,
    started_at     TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ,
    had_emergency  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_participant_tracks_event ON participant_tracks (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_tracks_participant
    ON participant_tracks (event_id, participant_id);

-- ---- client_actions (006) -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_actions (
    client_action_id UUID PRIMARY KEY,
    user_id          BIGINT,
    event_id         UUID,
    action_type      VARCHAR(50),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_status  INT,
    response_body    JSONB
);
CREATE INDEX IF NOT EXISTS idx_client_actions_created ON client_actions (created_at);

-- ---- event_groups (012) -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_groups (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   UUID NOT NULL,
    name       VARCHAR(120) NOT NULL,
    starts_at  TIMESTAMPTZ,
    route_id   BIGINT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_groups_event ON event_groups (event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_event_participants_group
    ON event_participants (group_id) WHERE group_id IS NOT NULL;

-- ---- teams / follows (013) ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR(200) NOT NULL,
    owner_id   BIGINT NOT NULL,
    avatar_url VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS user_follows (
    follower_id BIGINT NOT NULL,
    followee_id BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows (followee_id);

-- ---- entitlements / coupons (014) ---------------------------------------------------------
-- ⚠ buildActor() reads entitlement_grants on the event-create, event-detail, participants,
-- groups and teams paths. A database without this table fails those requests outright.
-- Note sql/015-local-schema-compat.sql creates entitlement_grants but NOT the two coupon
-- tables — redeemCoupon() needs both.
CREATE TABLE IF NOT EXISTS entitlement_grants (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL,
    plan_code  VARCHAR(50),
    feature    VARCHAR(50),
    quantity   INT,
    consumed   INT NOT NULL DEFAULT 0,
    scope_type VARCHAR(30),
    scope_id   VARCHAR(64),
    source     VARCHAR(30) NOT NULL,
    source_ref VARCHAR(160),
    starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT entitlement_grants_one_of_plan_or_feature
        CHECK ((plan_code IS NULL) <> (feature IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_entitlement_grants_user_live
    ON entitlement_grants (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entitlement_grants_source
    ON entitlement_grants (source, source_ref);

CREATE TABLE IF NOT EXISTS coupons (
    code            VARCHAR(64) PRIMARY KEY,
    plan_code       VARCHAR(50),
    feature         VARCHAR(50),
    quantity        INT,
    grant_days      INT,
    grant_until     TIMESTAMPTZ,
    max_redemptions INT,
    redeemed_count  INT NOT NULL DEFAULT 0,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMPTZ,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT coupons_one_of_plan_or_feature
        CHECK ((plan_code IS NULL) <> (feature IS NULL)),
    CONSTRAINT coupons_one_grant_window
        CHECK (grant_days IS NULL OR grant_until IS NULL)
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    coupon_code VARCHAR(64) NOT NULL,
    user_id     BIGINT NOT NULL,
    grant_id    BIGINT,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (coupon_code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon
    ON coupon_redemptions (coupon_code, redeemed_at DESC);

-- ---- remaining indexes named by a real query ----------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS events_code_key ON events (code);            -- ⚠ by-code lookup
CREATE INDEX IF NOT EXISTS idx_events_status_start   ON events (status, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_owner          ON events (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_team           ON events (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_public_browse
    ON events (activity_type, level) WHERE visibility = 'public';

CREATE UNIQUE INDEX IF NOT EXISTS event_participants_event_id_user_id_key
    ON event_participants (event_id, user_id);
CREATE INDEX IF NOT EXISTS event_participants_event_id_idx ON event_participants (event_id);
CREATE INDEX IF NOT EXISTS event_participants_user_id_idx  ON event_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_finish
    ON event_participants (event_id, finish_position, finished_at)
    WHERE result_status = 'finished';

CREATE INDEX IF NOT EXISTS location_points_participant_id_recorded_at_idx
    ON location_points (participant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_location_points_emergency
    ON location_points (participant_id, recorded_at DESC) WHERE emergency = TRUE;
-- The only index here that can be slow to build: location_points is the high-volume table.
-- If it does not already exist and the table is large, see the note at the bottom of this file.
CREATE INDEX IF NOT EXISTS idx_location_points_event_time
    ON location_points (event_id, recorded_at);

-- =======================================================================================
-- SECTION B2 — the one DROP, and it is required
-- =======================================================================================
-- From 010-drop-one-live-per-owner.sql. A plain unique index can only express "at most 1"
-- live event per owner; the product now allows N (MAX_CONCURRENT_LIVE_EVENTS_FREE, default 2)
-- and enforces the count in event.service.ts's changeEventStatus. Leaving this index in place
-- makes the second concurrent "go live" fail with a unique violation.
DROP INDEX IF EXISTS idx_events_one_live_per_owner;

COMMENT ON COLUMN events.visibility IS 'public | registered | private — see AUTHORIZATION.md';

COMMIT;

-- =======================================================================================
-- SECTION C — data backfills. NOT additive. Read before running.
-- =======================================================================================
-- Each is safe to re-run (the WHERE clause makes a second run match nothing), but each
-- CHANGES EXISTING ROWS. Run them one at a time.

-- C1. Owner membership for every event that predates the owner row being written at creation.
--     From 014-authorization.sql. Idempotent via NOT EXISTS.
INSERT INTO event_members (event_id, user_id, role)
SELECT e.id, e.owner_id, 'owner'
  FROM events e
 WHERE e.owner_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM event_members m WHERE m.event_id = e.id AND m.user_id = e.owner_id
   );

-- C2. location_points.event_id backfill, from 002-events-podium.sql.
--     ⚠ This one touches the high-volume table. If location_points is large, run it in
--     batches rather than as one statement (see the note at the bottom).
UPDATE location_points AS lp
   SET event_id = ep.event_id
  FROM event_participants AS ep
 WHERE ep.id = lp.participant_id
   AND lp.event_id IS NULL;

-- C3. ⚠ STRANDED DRAFTS. Required if you are shipping the client change that removes the
--     Publish button.
--
--     POST /api/v1/events now creates events as `published`, and the client no longer has a
--     Publish step. Any event ALREADY sitting in `draft` therefore has no way out: it is not
--     is_active, so GET /api/v1/events/by-code/:code returns 404 for it and no rider can join.
--
--     This publishes them and puts is_active back in step with status, using exactly the rule
--     the server applies (plan/02-database-schema.md:202):
--         is_active = status NOT IN ('draft', 'cancelled', 'finished')
--
--     Check what you are about to change first:
--         SELECT id, code, name, created_at FROM events WHERE status = 'draft';
UPDATE events
   SET status    = 'published',
       is_active = TRUE,
       updated_at = NOW()
 WHERE status = 'draft';

-- C4. Repair any row where is_active drifted out of step with status. No-op on a healthy
--     database; a safety net for rows written before the two were kept in sync.
UPDATE events
   SET is_active = (status NOT IN ('draft', 'cancelled', 'finished')),
       updated_at = NOW()
 WHERE is_active <> (status NOT IN ('draft', 'cancelled', 'finished'));

-- =======================================================================================
-- SECTION D — optional, and only if you want the database to agree with the product
-- =======================================================================================
-- The server always sends `status` explicitly on INSERT, so this default is never what
-- creates an event. It is worth changing anyway so that a hand-written INSERT, a restored
-- fixture or a future script cannot quietly reintroduce a draft that nothing can publish.
--
-- ALTER TABLE events ALTER COLUMN status SET DEFAULT 'published';

-- =======================================================================================
-- NOTE — large-table index builds
-- =======================================================================================
-- CREATE INDEX takes a lock that blocks writes for the duration. Every index above already
-- exists on a database that followed sql/README.md, so they are instant no-ops. The single
-- exception worth planning for is idx_location_points_event_time on a database where
-- location_points has grown large. If that is your case, remove that one statement from
-- Section B and build it without blocking writes instead — CONCURRENTLY cannot run inside a
-- transaction, so it must be its own statement outside this file:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_location_points_event_time
--         ON location_points (event_id, recorded_at);
--
-- And run C2 in batches rather than as one UPDATE:
--
--     UPDATE location_points AS lp
--        SET event_id = ep.event_id
--       FROM event_participants AS ep
--      WHERE ep.id = lp.participant_id
--        AND lp.event_id IS NULL
--        AND lp.id IN (SELECT id FROM location_points WHERE event_id IS NULL LIMIT 50000);
--     -- repeat until it reports UPDATE 0
