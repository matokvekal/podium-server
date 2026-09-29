-- 055-events-promote-registration-message.sql — the text a PROMOTE event shows INSTEAD of Join.
--
-- Free text written by the System Admin in Create/Edit Ride ("Registration Information"); http(s)
-- URLs inside it are made clickable by the client. NULL/empty = the built-in default
-- ("Registration is handled by the organizer."), so every existing PROMOTE event keeps working
-- with no backfill. The value is kept when PROMOTE is switched off, so switching it on again
-- restores the text.
--
-- (The Organizer display name needs no migration: it reuses events.organizer_group, sql/010.)
--
-- Additive and idempotent. The server guards its write against a database without this column
-- (a silent no-op plus a warning), so deploying code before running this is safe — but the
-- message cannot be saved until it has run.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS promote_registration_message TEXT;
