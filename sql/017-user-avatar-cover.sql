-- 017-user-avatar-cover.sql — a rider's own Avatar and Cover, which they choose and keep.
--
-- WHY THIS FILE EXISTS
--   users.avatar_url (001-init / 007) is the Google profile picture, written once at sign-up
--   and never again — there was no way for a rider to set their own picture, and no cover at
--   all. These four columns hold the identity the rider OWNS. Events do not copy them: an
--   event reaches its owner's images through events.owner_id, so a change is visible on every
--   ride at once and no image data is ever duplicated into an event row.
--
--   Two columns per image, not one:
--     *_type   'preset' — *_value is a stable id from the server's preset registry
--                         (src/config/user-image-presets.ts). The art ships with the code,
--                         one shared copy, never per user.
--              'upload' — *_value is a relative path under UPLOADS_DIR,
--                         'users/{userId}/avatar-{token}.{ext}'. Never an absolute path:
--                         where the upload root lives is deployment configuration, not data.
--              NULL     — nothing chosen; the API falls back to avatar_url as it always did.
--
--   No CHECK constraint and no enum type, matching role/status/visibility: the application
--   validates, and a value the server does not recognise degrades to the fallback rather
--   than breaking a row that is already stored.
--
--   No index. These are only ever read from a users row already fetched by primary key or
--   joined on user_id.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/017-user-avatar-cover.sql
--
-- SAFE ON LIVE DATA, and safe to run more than once. Every column is nullable with no
-- default, so ADD COLUMN is metadata-only (PostgreSQL 11+) and no existing row is rewritten.
-- Existing users keep working with all four NULL, and so does every existing client.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_type  VARCHAR(16),
    ADD COLUMN IF NOT EXISTS avatar_value VARCHAR(255),
    ADD COLUMN IF NOT EXISTS cover_type   VARCHAR(16),
    ADD COLUMN IF NOT EXISTS cover_value  VARCHAR(255);
