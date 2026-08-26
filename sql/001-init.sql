-- 001-init.sql — the tables the server uses today, as they should be.
--
-- Run this on a FRESH database. An existing (Prisma-created) database already has these
-- tables with TIMESTAMP(3) columns: run sql/900-timestamptz-migration.sql instead, then
-- carry on from 002.
--
-- Rules for every file in this folder (plan/02-database-schema.md):
--   * every timestamp is TIMESTAMPTZ and the database stores UTC only
--   * no foreign keys — the application enforces relationships
--   * indexes only where a real query needs one, and each one names its query
--   * ⚠ marks a column the live Android transmitter reads. Never rename those.

CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name VARCHAR(200),
    last_name VARCHAR(200),
    nickname VARCHAR(200),
    emergency_phone VARCHAR(100),     -- collected by the app; not displayed in v1
    avatar_url VARCHAR(500),          -- Google profile picture, shown in lists
    role VARCHAR(30) NOT NULL DEFAULT 'RIDER',   -- global account flag: RIDER | COMMISSAIRE
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_identities (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL,
    provider VARCHAR(30) NOT NULL,    -- GOOGLE | SMS | EMAIL_PASSWORD
    provider_user_id VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(100),
    password_hash TEXT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- Login lookup, and the pair a sign-in is keyed on.
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_provider_user_id_key
    ON auth_identities (provider, provider_user_id);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL,
    refresh_token_hash TEXT NOT NULL,  -- sha256 of the opaque token; the token is never stored
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    device_info TEXT,
    ip_address VARCHAR(64)
);

-- Refresh lookup: every /auth/refresh call hits this.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_key
    ON sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);   -- logout-all
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at); -- cleanup

CREATE TABLE IF NOT EXISTS otp_challenges (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone VARCHAR(100) NOT NULL,
    code_hash TEXT NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    request_ip VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS otp_challenges_phone_idx ON otp_challenges (phone);
CREATE INDEX IF NOT EXISTS otp_challenges_expires_at_idx ON otp_challenges (expires_at);

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(32) NOT NULL,          -- ⚠ Android looks an event up by this. DDMMYYYY + A/B/C…
    name VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL DEFAULT 'RIDE',   -- ⚠ RIDE | RACE
    requires_bib BOOLEAN NOT NULL DEFAULT FALSE, -- ⚠
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,     -- ⚠ the by-code lookup filters on this
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Join by code / QR scan.
CREATE UNIQUE INDEX IF NOT EXISTS events_code_key ON events (code);
----------------
-- ⚠ event_participants.id IS `participantId` — the id the transmitter stores after joining
-- and sends with every location batch. Never change its meaning.
CREATE TABLE IF NOT EXISTS event_participants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL,
    user_id BIGINT,                     -- NULL for manual and Excel-imported riders
    bib VARCHAR(16),                    -- ⚠ Android sends this on join
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ
);
--------------------------------
-- The join upsert conflicts on this pair. NULLs count as distinct, so any number of
-- account-less participants coexist while a real user cannot join twice.
CREATE UNIQUE INDEX IF NOT EXISTS event_participants_event_id_user_id_key
    ON event_participants (event_id, user_id);
CREATE INDEX IF NOT EXISTS event_participants_event_id_idx ON event_participants (event_id);
CREATE INDEX IF NOT EXISTS event_participants_user_id_idx ON event_participants (user_id);

-- Raw GPS. High volume, and the only table that is ever deleted from.
-- ⚠ Column names match the Android app's JSON exactly.
CREATE TABLE IF NOT EXISTS location_points (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    participant_id BIGINT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ NOT NULL,   -- device GPS time — can be hours before received_at
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    emergency BOOLEAN NOT NULL DEFAULT FALSE  -- rider pressed SOS
);

-- Rebuilding one rider's track.
CREATE INDEX IF NOT EXISTS location_points_participant_id_recorded_at_idx
    ON location_points (participant_id, recorded_at);
