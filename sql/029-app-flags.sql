-- 029-app-flags.sql — a tiny key/value table for account-wide switches an operator flips by hand.
--
-- WHY THIS EXISTS
--   Some things are a single global decision, not a per-user grant: "is ride creation open to
--   everyone right now?". Modelling that as an entitlement_grants row per user (and per future
--   signup) is the wrong shape. An env var would work but needs an SSH session and a
--   `pm2 restart` to change; this table is flipped with one UPDATE in psql and takes effect on
--   the next request (within the read cache's TTL — see src/queries/appFlags.queries.ts).
--
-- SHAPE
--   key         TEXT PRIMARY KEY     — a short stable identifier, snake_case
--   value       TEXT NOT NULL        — 'true' / 'false' for a boolean flag; free text otherwise
--   note        TEXT                 — what it does and who to ask before changing it
--   updated_at  TIMESTAMPTZ NOT NULL
--
--   Deliberately generic. The reader in code decides how to interpret `value` for each key.
--
-- THE FLAGS THIS FILE SEEDS
--   event_creation_open_to_all — when 'true', EVERY signed-in account may create rides, exactly
--     as it worked before sql/027 gated it. When 'false' (the default, and how it ships), ride
--     creation needs the `create_events` feature — a paid organizer plan, or a manual grant
--     (sql/027 template). Read by src/authz/entitlements.ts.
--
--     Open it:   UPDATE app_flags SET value = 'true',  updated_at = NOW() WHERE key = 'event_creation_open_to_all';
--     Close it:  UPDATE app_flags SET value = 'false', updated_at = NOW() WHERE key = 'event_creation_open_to_all';
--
--     Closing it does NOT revoke anyone's per-account grant — those keep working. It only stops
--     the blanket "everyone" access. New accounts created while it was open lose creation again.
--
-- BACKWARDS COMPATIBILITY
--   The reader swallows a missing table (42P01) and treats every flag as its default, so the
--   server runs fine before this file is applied. Additive, new table, no existing row touched.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/029-app-flags.sql
--
-- SAFE ON LIVE DATA and safe to run more than once.

CREATE TABLE IF NOT EXISTS app_flags (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    note       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_flags (key, value, note)
VALUES (
    'event_creation_open_to_all',
    'false',
    'true = every signed-in account may create rides (pre-sql/027 behaviour). false = needs the create_events feature. Read by src/authz/entitlements.ts.'
)
ON CONFLICT (key) DO NOTHING;

-- Verify afterwards:
--   SELECT key, value, updated_at FROM app_flags ORDER BY key;
