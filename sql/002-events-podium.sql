-- 002-events-podium.sql — ownership, lifecycle and visibility on events.
--
-- owner_id is the important one: today nothing owns an event, and nearly every permission
-- rule ("my events", "only the organizer may start it", "private to whom?") needs it.
--
-- Safe to run on the live database: every statement is additive.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS owner_id BIGINT,
    ADD COLUMN IF NOT EXISTS display_mode VARCHAR(30) NOT NULL DEFAULT 'standard', -- standard | competition
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS visibility VARCHAR(30) NOT NULL DEFAULT 'private',    -- public | private
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS location VARCHAR(255),
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,

    -- Per-event visibility defaults: what MAY OTHER PEOPLE see. Per event, not per user —
    -- a public event has an audience nobody can enumerate in advance, so there is no user
    -- row to grant anything to. What a specific person may DO is event_members.role.
    ADD COLUMN IF NOT EXISTS show_event_info BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_participants BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_route BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_live_locations BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_history_locations BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS show_results BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing events predate the lifecycle and are all live-and-joinable today. Give them a
-- status that matches what is_active already says, so the Android by-code lookup is
-- unaffected. Run once, right after the ALTER.
UPDATE events SET status = 'published' WHERE is_active = TRUE AND status = 'draft';

-- is_active stays: it is what the transmitter's by-code lookup filters on. status carries
-- the fuller lifecycle, and the application keeps the two in step:
--     is_active = (status NOT IN ('draft', 'cancelled', 'finished'))

-- Events page: current / upcoming / past.
CREATE INDEX IF NOT EXISTS idx_events_status_start ON events (status, starts_at);
-- "Events I own".
CREATE INDEX IF NOT EXISTS idx_events_owner ON events (owner_id);

-- Who may operate an event, as opposed to who is riding in it (that is
-- event_participants). A person who both rides and organizes has a row in both tables.
CREATE TABLE IF NOT EXISTS event_members (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    role VARCHAR(30) NOT NULL,          -- owner | operator | viewer
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One role per person per event.
CREATE UNIQUE INDEX IF NOT EXISTS event_members_event_id_user_id_key
    ON event_members (event_id, user_id);
-- "Events I operate".
CREATE INDEX IF NOT EXISTS idx_event_members_user ON event_members (user_id);
-- Member list for one event.
CREATE INDEX IF NOT EXISTS idx_event_members_event ON event_members (event_id);

-- location_points.event_id: strictly derivable by joining through event_participants, but
-- storing it turns retention cleanup and per-event export into single statements over a
-- table with millions of rows. Backfill before making it NOT NULL.
ALTER TABLE location_points ADD COLUMN IF NOT EXISTS event_id UUID;

UPDATE location_points AS lp
   SET event_id = ep.event_id
  FROM event_participants AS ep
 WHERE ep.id = lp.participant_id
   AND lp.event_id IS NULL;

-- Retention cleanup and per-event export.
CREATE INDEX IF NOT EXISTS idx_location_points_event_time
    ON location_points (event_id, recorded_at);

-- Active SOS riders in one event.
CREATE INDEX IF NOT EXISTS idx_location_points_emergency
    ON location_points (participant_id, recorded_at DESC)
    WHERE emergency = TRUE;
