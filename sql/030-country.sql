-- 030-country.sql — a country on the user and on the event.
--
-- WHY THESE COLUMNS EXIST
--   The "Browse tracks" picker in event-create lists public rides worldwide. An organiser in
--   Israel does not want to scroll past tracks from the United States. Country is the one
--   filter with no data behind it: there was no country anywhere on the server — the client's
--   profile-setup screen collected one but kept it in localStorage only (store/countryStore.ts),
--   wiped on logout, never sent anywhere.
--
--   This adds:
--     users.country   the rider's country, ISO 3166-1 alpha-2. Set automatically from the
--                     browser locale on first login (the client PATCHes /users/me), and
--                     changeable by the rider on the account screen. NULL for a rider whose
--                     client has not synced it yet.
--     events.country  the country the ride is in — stamped at creation from the organiser's
--                     users.country (falling back to 'IL'). The picker filters on it.
--
-- SHAPE
--   country  CHAR(2)  (nullable on both tables)
--
--   Two letters, stored uppercase — the same shape as event_participants.country_code
--   (sql/009-results.sql) and the zod schema (.length(2).regex(/^[A-Za-z]{2}$/), upper-cased).
--
-- BACKFILL
--   The app is Israel-only today, so every existing ride is set to 'IL' — the browse filter is
--   then always an exact match with no NULLs to reason about. users.country is left NULL: each
--   rider's own client fills it in from their real locale on next login, which is more correct
--   per-user than a blanket 'IL'.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the code BEFORE OR AFTER this file. The server reads both tables with
--   `SELECT *` and maps `row.country ?? null`; the profile write goes through updateUserProfile
--   (COALESCE, so an absent column is caught as isMissingColumnError upstream) and the event
--   write goes through updateEventCountry, guarded by isMissingColumnError exactly like
--   updateEventElevationGain. Before this runs, the value simply does not persist and the
--   server logs a warning naming this file; nothing fails a save, and the country filter is a
--   no-op.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/030-country.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default is
-- metadata-only in PostgreSQL 11+. The one UPDATE only touches rows where country IS NULL, so a
-- re-run after riders have set their own event countries is a no-op.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS country CHAR(2);

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS country CHAR(2);

-- Israel-only today: every existing ride is IL. Idempotent — later rows created with a real
-- country are not touched.
UPDATE events SET country = 'IL' WHERE country IS NULL;

-- The picker filters public rides by country; this is the index behind that WHERE.
CREATE INDEX IF NOT EXISTS idx_events_public_country
    ON events (country) WHERE visibility = 'public';

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE (table_name = 'users' OR table_name = 'events') AND column_name = 'country';
--   SELECT country, count(*) FROM events GROUP BY 1;
