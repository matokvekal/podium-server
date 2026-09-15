-- 034-users-weight.sql — the rider's body weight, for a PERSONAL calorie estimate.
--
-- WHY THIS COLUMN EXISTS
--   Rider Statistics shows a lifetime/yearly calorie total. The calorie formula needs the
--   rider's weight — a genuine per-user preference, not a usage counter — same shape as
--   users.country (sql/030): set once by the rider, changed by the rider, read by everything
--   that needs it.
--
-- NULLABLE, NO DEFAULT. NULL means "the rider has never set a weight" — the statistics response
-- returns `calories: null` for that rider rather than inventing a number with a made-up default,
-- the same "never ship an invented number" rule sql/022's header states for ride duration.
--
-- BOUNDS mirror the client's existing slider (WEIGHT_MIN_KG=40, WEIGHT_MAX_KG=120) so a value
-- that could not have come from the app's own UI is rejected at the database, not just zod.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/034-users-weight.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default is
-- metadata-only in PostgreSQL 11+; every existing row stays NULL.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,1);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_weight_kg_range'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_weight_kg_range
            CHECK (weight_kg IS NULL OR (weight_kg >= 40 AND weight_kg <= 120));
    END IF;
END $$;

-- Verify afterwards:
--   SELECT COUNT(*) FILTER (WHERE weight_kg IS NOT NULL) AS with_weight, COUNT(*) FROM users;
--   -- with_weight should be 0 right after this runs; it fills in as riders visit Statistics.
