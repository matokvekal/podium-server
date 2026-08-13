-- 900-timestamptz-migration.sql
--
-- ⚠ THE ONE RISKY SCRIPT IN THIS FOLDER. Read all of it before running any of it.
--
-- Every timestamp column in the live database is TIMESTAMP(3) — no timezone. That is a
-- Prisma default, and for a system where riders upload hours-old GPS points from the road
-- it is a real bug, not a style preference.
--
-- Prisma stored UTC in those columns, so the conversion has to SAY SO:
--
--     ... TYPE TIMESTAMPTZ USING column AT TIME ZONE 'UTC'
--
-- If AT TIME ZONE 'UTC' is omitted, PostgreSQL assumes the SERVER's local timezone and
-- every existing timestamp silently shifts by several hours. There is no error and no
-- warning. That is the entire risk in this file.
--
-- Before running:
--   1. back up the database          pg_dump -Fc -f podium-before-tz.dump "$DATABASE_URL"
--   2. run the BEFORE queries below and keep the output
--   3. run the migration
--   4. run the AFTER queries and compare — the instants must be identical
--
-- Only run this on a database created by Prisma. A database built from 001-init.sql is
-- already TIMESTAMPTZ, and re-running is harmless but pointless.

-- ---------------------------------------------------------------------------
-- BEFORE — capture known rows. Keep this output.
-- ---------------------------------------------------------------------------
-- SELECT id, recorded_at, received_at FROM location_points ORDER BY id LIMIT 5;
-- SELECT id, created_at, expires_at FROM sessions ORDER BY id DESC LIMIT 5;
-- SELECT id, code, created_at FROM events ORDER BY created_at LIMIT 5;
--
-- The same rows must read as the same instants afterwards. `recorded_at` printed as
-- 09:14:02 before must print as 09:14:02+00 after — not 12:14:02+00.

BEGIN;

-- Session timezone is set explicitly so nothing here depends on the server's setting.
SET LOCAL TIME ZONE 'UTC';

ALTER TABLE users
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC',
    ALTER COLUMN last_login_at TYPE TIMESTAMPTZ USING last_login_at AT TIME ZONE 'UTC';

ALTER TABLE auth_identities
    ALTER COLUMN verified_at TYPE TIMESTAMPTZ USING verified_at AT TIME ZONE 'UTC',
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC',
    ALTER COLUMN last_used_at TYPE TIMESTAMPTZ USING last_used_at AT TIME ZONE 'UTC';

ALTER TABLE sessions
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC',
    ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING revoked_at AT TIME ZONE 'UTC',
    ALTER COLUMN last_used_at TYPE TIMESTAMPTZ USING last_used_at AT TIME ZONE 'UTC';

ALTER TABLE otp_challenges
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC',
    ALTER COLUMN consumed_at TYPE TIMESTAMPTZ USING consumed_at AT TIME ZONE 'UTC';

ALTER TABLE events
    ALTER COLUMN starts_at TYPE TIMESTAMPTZ USING starts_at AT TIME ZONE 'UTC',
    ALTER COLUMN ends_at TYPE TIMESTAMPTZ USING ends_at AT TIME ZONE 'UTC',
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE event_participants
    ALTER COLUMN joined_at TYPE TIMESTAMPTZ USING joined_at AT TIME ZONE 'UTC',
    ALTER COLUMN left_at TYPE TIMESTAMPTZ USING left_at AT TIME ZONE 'UTC';

-- The one that matters most: a delayed batch's recorded_at is the rider's real time.
ALTER TABLE location_points
    ALTER COLUMN recorded_at TYPE TIMESTAMPTZ USING recorded_at AT TIME ZONE 'UTC',
    ALTER COLUMN received_at TYPE TIMESTAMPTZ USING received_at AT TIME ZONE 'UTC';

-- Prisma left these defaults as CURRENT_TIMESTAMP, which is correct for TIMESTAMPTZ too;
-- restated here so a fresh column and a migrated one behave identically.
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE auth_identities ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE sessions ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE otp_challenges ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE events ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE event_participants ALTER COLUMN joined_at SET DEFAULT NOW();
ALTER TABLE location_points ALTER COLUMN received_at SET DEFAULT NOW();

-- Prisma maintained updated_at from the client, and so does this server — but a default
-- means an INSERT that forgets it still gets a sane value instead of failing.
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE auth_identities ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE events ALTER COLUMN updated_at SET DEFAULT NOW();

COMMIT;

-- ---------------------------------------------------------------------------
-- AFTER — verify. Every column below must say timestamptz.
-- ---------------------------------------------------------------------------
-- SELECT table_name, column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
--  ORDER BY table_name, column_name;
--
-- Then re-run the BEFORE queries and compare the instants. If anything shifted by a whole
-- number of hours, the USING clause was lost somewhere — restore the dump and start again.
--
-- Finally, the check that actually proves it (plan/11-prisma-removal.md step 7): with the
-- REAL Android app, join an event, transmit for a minute, then turn airplane mode on for
-- two minutes while still riding and turn it off. The queued points must arrive with their
-- ORIGINAL recorded_at, not the upload time.
