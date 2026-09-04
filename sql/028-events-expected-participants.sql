-- 028-events-expected-participants.sql — one organizer-set number on an event:
--   * how many riders the organizer expects (expected_participants)
--
-- WHY THIS COLUMN EXISTS
--   The event page used to show "12 / 300 participants", where 300 was the organizer's PLAN
--   LIMIT (user_limits.participants_per_event). That ceiling is an account-level cap the server
--   enforces on join — it is not a figure any viewer should see, and it made small rides look
--   like they had 288 empty seats.
--
--   What a rider actually wants next to the count is the organizer's own estimate of turnout.
--   Nothing in the data implies it — not the route, not the cap, not the current count — so,
--   like duration_min and is_accessible in sql/022, it is stored, never derived. The plan limit
--   stays where it belongs: enforced server-side, shown to the organizer on the create form,
--   never serialised to anyone else.
--
-- SHAPE
--   expected_participants  INT   (nullable)
--
--   Nullable, no default. NULL means "the organizer left it blank" — the event page then shows
--   just the count ("12 participants"), no denominator. A positive integer shows as "12 / 40".
--   Unlike has_support_vehicle there IS a real difference between "not stated" and any number,
--   so this is a genuine tri-state and stays nullable rather than defaulting to 0.
--
-- BACKWARDS COMPATIBILITY
--   Every existing row is NULL and unchanged. The server reads events with `SELECT *` and maps
--   `row.expected_participants ?? null`, and writes go through updateEventRidePlan, which is
--   guarded by isMissingColumnError — so the code is safe to deploy BOTH BEFORE AND AFTER this
--   file runs. Before it runs the number simply does not persist and the server logs a warning
--   naming this file; nothing fails a save.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/028-events-expected-participants.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default is
-- metadata-only in PostgreSQL 11+ — no table rewrite, no long lock, no backfill scan. Nothing
-- is dropped, renamed, retyped or deleted.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS expected_participants INT;

-- A light sanity bound, matching the zod schema (positive, <= 100000). Guarded so a re-run
-- does not error on the existing constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_expected_participants_sane'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_expected_participants_sane
            CHECK (expected_participants IS NULL
                   OR (expected_participants > 0 AND expected_participants <= 100000));
    END IF;
END $$;

-- No index: the column is only ever read as part of a row already selected by id or by the
-- owner / participant filters.

-- Verify afterwards:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name = 'expected_participants';
--   SELECT expected_participants IS NULL AS blank, count(*) FROM events GROUP BY 1;
