-- 053-events-promote-only.sql — PROMOTE mode: an ordinary event that is shown as a normal card
-- but locked for everyone except the System Admin and the event's owner, until the admin
-- switches it off (Edit -> PROMOTE off -> Save). Same event row, same id, no conversion.
--
-- Additive and idempotent. Existing rows get FALSE, so every current event behaves exactly as
-- before. The server guards its write against a database without this column (a silent no-op
-- plus a warning), so deploying code before running this is safe — but PROMOTE cannot be
-- turned on until it has run.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS promote_only BOOLEAN NOT NULL DEFAULT FALSE;
