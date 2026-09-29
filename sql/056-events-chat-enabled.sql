-- 056-events-chat-enabled.sql — per-event "Enable Chat" switch.
--
-- true  = the ride has a chat (today's behaviour).
-- false = the owner switched it off: the server refuses chat reads/sends for that ride and no
--         unread counts are produced; the client hides the button and stops polling.
--
-- Additive and idempotent. Every existing event becomes chat-enabled (DEFAULT TRUE). Nothing in
-- ride_chat_messages is read, changed or deleted, so switching chat off and on again keeps the
-- history. The server guards its write against a database without this column (a warning and a
-- no-op), so deploying code before running this is safe — chat just cannot be switched off yet.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS chat_enabled BOOLEAN NOT NULL DEFAULT TRUE;
