-- 008-registration-and-live.sql — approval-required registration, pausing a live event, and
-- the one-live-event-per-owner rule.
--
-- Safe to run on the live database: every statement is additive.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE;

-- An owner may only have one event live at a time. The app-level check in
-- event.service.ts (changeEventStatus) is the primary guard; this index is the backstop for
-- two concurrent "Start" requests racing past that check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_one_live_per_owner
    ON events (owner_id) WHERE status = 'live';
