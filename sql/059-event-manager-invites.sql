-- 059-event-manager-invites.sql — ride managers invited by an email that has no account yet.
--
--   event_manager_invites(id, event_id, email, invited_by, created_at)
--
-- WHY THIS EXISTS
--   A ride's creator can name other people as MANAGERS of the ride by email. A manager does
--   everything the creator does — edit, change the route, run the riders, cancel the ride —
--   except appoint or remove managers (policy.ts "event:manage_members").
--
--   A manager who already has an account is NOT stored here: they are an event_members row with
--   role = 'operator' (sql/002), the role table that already existed for exactly this. This
--   table holds only the emails nobody has signed in with yet. The first Google sign-in with a
--   verified matching email turns each row into an 'operator' member and deletes it
--   (eventManagers.service.ts claimManagerInvites).
--
-- SHAPE NOTES
--   No foreign key — this schema has none anywhere (sql/README.md).
--   email is stored trimmed and lower-cased by the server; the unique index makes a repeated
--   invite a no-op.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs: the managers list treats a
--   missing table as "no pending invites", the sign-in claim skips it, and inviting an unknown
--   email against a database without it fails with a clear error. Managers with an account
--   need nothing from this file.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/059-event-manager-invites.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: a new table that starts empty.

CREATE TABLE IF NOT EXISTS event_manager_invites (
    id          BIGSERIAL   PRIMARY KEY,
    event_id    UUID        NOT NULL,
    email       TEXT        NOT NULL,
    invited_by  BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_manager_invites_event_email
    ON event_manager_invites (event_id, email);

CREATE INDEX IF NOT EXISTS idx_event_manager_invites_email
    ON event_manager_invites (email);
