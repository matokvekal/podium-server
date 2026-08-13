-- 005-tracking.sql — the two tables that are not raw GPS.
--
-- Three tables hold positions, and they differ by LIFETIME, not by shape:
--   location_points            raw, as the app sends it   -> purged after the window
--   participant_last_location  where everyone is now      -> overwritten continuously
--   participant_tracks         the ride line, at finish   -> kept forever

-- The live map asks one question — where is everyone right now — and answering it from
-- location_points means scanning a table that grows all event long. Ingest upserts one row
-- per rider here, and GET /events/:id/live reads only this table.
CREATE TABLE IF NOT EXISTS participant_last_location (
    event_id UUID NOT NULL,
    participant_id BIGINT NOT NULL,
    recorded_at TIMESTAMPTZ,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    emergency BOOLEAN NOT NULL DEFAULT FALSE,
    distance_travelled_km DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, participant_id)
);

-- The primary key already serves the live query — no extra index.
--
-- ONLY NEWER POINTS MAY WIN. A rider leaving a dead zone uploads a batch of old points;
-- those must never drag their marker backwards on the map:
--
--   INSERT INTO participant_last_location AS pll (...) VALUES (...)
--   ON CONFLICT (event_id, participant_id) DO UPDATE SET ...
--    WHERE pll.recorded_at IS NULL OR pll.recorded_at < EXCLUDED.recorded_at;

-- Written once, when the event finishes: each rider's ride reduced to a simplified line.
-- This is what the History screen draws, and it is NEVER purged. The raw-point cleanup
-- must not run for an event until these rows exist.
CREATE TABLE IF NOT EXISTS participant_tracks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL,
    participant_id BIGINT NOT NULL,
    points JSONB,                    -- simplified [[lat, lng], ...]
    point_count INT,
    distance_km DOUBLE PRECISION,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    had_emergency BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- History screen: every track for one event.
CREATE INDEX IF NOT EXISTS idx_participant_tracks_event ON participant_tracks (event_id);
-- One rider's saved track.
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_tracks_participant
    ON participant_tracks (event_id, participant_id);
