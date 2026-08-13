-- 006-client-actions.sql — offline de-duplication.
--
-- The PWA queues mutating actions while offline and replays them on reconnect. A retry the
-- server already applied must not apply twice: a rider marked finished twice, a participant
-- added twice. Every mutating request carries a client-generated UUID in the
-- X-Client-Action-Id header; the server records it here and answers a repeat with 409
-- carrying the original result, which the client treats as success.
--
-- The transmitter's /events/join needs no action id — it is already idempotent by upsert.

CREATE TABLE IF NOT EXISTS client_actions (
    client_action_id UUID PRIMARY KEY,
    user_id BIGINT,
    event_id UUID,
    action_type VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purged on the same schedule as location_points.
CREATE INDEX IF NOT EXISTS idx_client_actions_created ON client_actions (created_at);
