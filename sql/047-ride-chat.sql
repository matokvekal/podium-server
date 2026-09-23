-- 047-ride-chat.sql — a shared text chat per ride.
--
-- WHAT IT IS
--   One table. Each row is one message in ONE ride's chat; the ride IS the conversation, so
--   there is no conversation / group / member table. Who may read or write a ride's chat is
--   the existing ride authorization (organizer, co-organizer or an approved rider —
--   src/authz/policy.ts "event:chat"), checked by the server on every read and write.
--
-- SHAPE NOTES
--   user_id is the identity (users.id). user_name_snapshot is the name the sender had WHEN
--   they wrote it — for display only, so an old message still reads the way it was sent; it is
--   never used to identify anyone.
--
--   ride_id is UUID to match events.id. No foreign keys, like every table in this schema
--   (sql/001-init.sql, sql/README.md). Deleting a ride in this app is a soft cancel
--   (status = 'cancelled', DELETE /events/:id), so messages stay with the ride id and remain
--   readable from History; nothing here cascades or deletes.
--
--   Limits (500 characters per message, 500 messages per ride) are server constants in
--   src/config/ride-chat.ts so they can change without a migration. The CHECK below is only a
--   loose backstop against a bug, not the product limit.
--
-- THE ONE INDEX
--   (ride_id, id) serves every read: a ride's history in order, "only messages after id N"
--   polling, the per-ride count behind the message limit, and MAX(id) for unread badges.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/047-ride-chat.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. Creates one new, empty table and one index.
-- Nothing existing is dropped, renamed, retyped, read or written.

CREATE TABLE IF NOT EXISTS ride_chat_messages (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id            UUID         NOT NULL,  -- events.id — the ride this message belongs to
    user_id            BIGINT       NOT NULL,  -- users.id  — who wrote it (the identity)
    user_name_snapshot VARCHAR(120),           -- their display name at the time (display only)
    message            TEXT         NOT NULL
                       CHECK (char_length(message) BETWEEN 1 AND 4000),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_chat_messages_ride_id
    ON ride_chat_messages (ride_id, id);

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT count(*) FROM ride_chat_messages;   -- expect 0
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ride_chat_messages' ORDER BY 1;
--   -- expect: idx_ride_chat_messages_ride_id, ride_chat_messages_pkey
