-- 025-track-copy-lineage.sql — who copied whose track, and how many times a track has been used.
--
--   * events.copied_from_event_id / copied_from_route_id  — lineage on the RIDE
--   * route_copies                                        — append-only ledger on the TRACK
--
-- WHY THIS EXISTS
--   A ride and a track are two different entities. One rider creates a track; other riders
--   build their own rides on it. Nothing recorded that relationship until now, so a track had
--   no way to say "twelve rides have been built on me" and a ride had no way to say "I came
--   from Dani's ride".
--
--   Three requirements drove the shape, in the organizer's own words:
--     1. a ride copied from another ride carries the source ride's id (copy_from);
--     2. the SOURCE TRACK's counter goes +1;
--     3. that number NEVER goes back down — "may the ride delete but the track stay,
--        like the ride and the track are 2 different entities".
--
-- WHY A LEDGER AND NOT A COUNTER COLUMN
--   sql/018-user-limits.sql sets the house rule: counts are read from the rows themselves, so
--   a stored counter can never drift from reality. A `routes.copy_count INT` incremented by
--   hand would drift the first time a request half-failed, and could never be recomputed.
--
--   But requirement 3 rules out the other obvious derivation, COUNT(*) over event_routes:
--   that counts LIVE LINKS, so it drops the moment a copier detaches the track or their ride
--   goes away. The number would go down, which is exactly what must not happen.
--
--   route_copies is the third option and satisfies both: the count is still derived from real
--   rows (so it never drifts), but the rows are INSERTed and never UPDATEd or DELETEd, so the
--   count can only ever go up. Cancelling the source ride, detaching the track, or deleting
--   the copier's ride all leave the row untouched.
--
-- WHAT COUNTS AS ONE COPY
--   One RIDE counts once against a given TRACK, enforced by the unique index below rather than
--   by application logic — re-saving the same ride, or detaching and re-attaching the same
--   track, can then never double-count no matter what the server does. Copying your own track
--   does not count at all; that check lives in the service (recordRouteCopy), not here, because
--   it is a product rule rather than an integrity rule.
--
--   source_event_id is NULL for a track picked straight out of Find Tracks: there is no source
--   ride in that flow. It still counts — the track was still used.
--
-- SHAPE NOTES
--   No foreign keys. This schema has none anywhere (sql/001-init.sql, sql/README.md); all
--   relational cleanup is application code. That is deliberate here too: route_copies must
--   survive the rows it points at going away, which is the whole point of requirement 3. A real
--   FK with ON DELETE CASCADE would destroy the feature.
--
--   copied_from_event_id / copied_from_route_id are both nullable. A ride whose track was
--   uploaded from a file or drawn by hand has neither. A ride copied from Find Tracks has only
--   the route id. A ride copied from another ride has both.
--
-- BACKWARDS COMPATIBILITY
--   The server reads events with `SELECT *` and maps `row.copied_from_event_id ?? null`, and
--   writes them through updateEventCopiedFrom, which is guarded by isMissingColumnError — the
--   same pattern sql/022 and sql/024 use. Every route_copies write is wrapped in try/catch and
--   only warns. So the server code is safe to deploy BOTH BEFORE AND AFTER this file runs:
--   before it runs, lineage simply does not persist and the count stays 0, and the server logs
--   a warning naming this file. Nothing fails a save over a counter.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/025-track-copy-lineage.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. ADD COLUMN IF NOT EXISTS with no default is
-- metadata-only in PostgreSQL 11+ — no table rewrite, no long lock, no backfill scan. The new
-- table starts empty. Nothing is dropped, renamed, retyped or deleted, and no existing row is
-- read or written by this file.
--
-- This file creates the SCHEMA ONLY. Seeding the ledger from the reuse that already exists in
-- event_routes is a separate, separately-approved file: sql/026-route-copies-backfill.sql.

------------------------------------------------------------------------------------------
-- 1. Lineage on the ride
------------------------------------------------------------------------------------------

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS copied_from_event_id UUID,
    ADD COLUMN IF NOT EXISTS copied_from_route_id BIGINT;

-- No index. Both columns are only ever read as part of a row already selected by id, to render
-- "Copied from …" on the ride's own detail page. If "rides built from my ride" ever becomes a
-- list, add a partial index on the NOT NULL rows then.

------------------------------------------------------------------------------------------
-- 2. The append-only ledger on the track
------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS route_copies (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id          BIGINT NOT NULL,  -- routes.id — the track that got used
    copied_by_user_id BIGINT NOT NULL,  -- users.id — who built a ride on it
    new_event_id      UUID   NOT NULL,  -- events.id — the ride they built
    source_event_id   UUID,             -- events.id copied from; NULL = picked from Find Tracks
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE INTEGRITY RULE: one ride counts once against a given track, however many times it saves.
-- Every insert relies on this via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS route_copies_route_event_key
    ON route_copies (route_id, new_event_id);

-- The counter read: SELECT COUNT(*) FROM route_copies WHERE route_id = $1.
CREATE INDEX IF NOT EXISTS idx_route_copies_route ON route_copies (route_id);

-- "tracks this rider has built on" / "who has used my track".
CREATE INDEX IF NOT EXISTS idx_route_copies_user ON route_copies (copied_by_user_id);

------------------------------------------------------------------------------------------
-- 3. A missing index on the existing join table
------------------------------------------------------------------------------------------

-- event_routes has idx_event_routes_event (event_id) only, so every reverse lookup — "which
-- rides use this track", which the backfill in 026 does once and any future admin query does
-- again — is a sequential scan today.
CREATE INDEX IF NOT EXISTS idx_event_routes_route ON event_routes (route_id);

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name LIKE 'copied_from%';
--   -- expect 2 rows: copied_from_event_id uuid YES, copied_from_route_id bigint YES
--
--   SELECT count(*) FROM route_copies;          -- expect 0 until sql/026 runs
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename IN ('route_copies', 'event_routes') ORDER BY 1;
--   -- expect: idx_event_routes_event, idx_event_routes_route, idx_route_copies_route,
--   --         idx_route_copies_user, route_copies_pkey, route_copies_route_event_key
--
-- Then run this whole file a SECOND time: it must succeed unchanged and report no errors.
