-- 037-event-link-groups.sql — one share link covering several rides on the same day.
--
--   events.link_group_id  — a UUID shared by 2-3 rides that are shared together.
--
-- WHY THIS EXISTS
--   An organizer regularly creates more than one ride for the same day: a long one and a short
--   one that start together, or a road ride and a gravel ride. Today each ride has its own
--   join link (/join/<code>), so the organizer posts two links into a group chat and explains
--   in words which is which. Riders pick the wrong one, join both, or join neither.
--
--   This column lets 2-3 rides share ONE link (/share/<codeA>-<codeB>), which opens a chooser
--   page: "<Owner> created 2 rides - which one are you riding?". The rides stay entirely
--   separate rides. Nothing about participants, results, live tracking, ride groups or the
--   frozen Android contract changes. Only the LINK is unified.
--
-- WHY A COLUMN AND NOT A JOIN TABLE
--   The feature needs no group metadata - no label, no history, no created_by - so a second
--   table would only add work:
--
--     * "a ride is in at most one link group" is STRUCTURAL here; a join table needs a unique
--       index and a service guard to say the same thing;
--     * removing a ride from its group is SET NULL, not a DELETE plus orphan cleanup;
--     * "are these rides actually shared together?" - the question the share endpoint exists
--       to answer - is one equality on one column, not a self-join;
--     * this schema has no foreign keys anywhere (sql/001-init.sql, sql/README.md), so a
--       membership row would be free to point at a ride that no longer exists. A column
--       cannot dangle.
--
--   A group of ONE is not a group. The service clears the last remaining member rather than
--   leaving a ride pointing at a group only it belongs to, and the share endpoint treats a
--   single surviving member as a plain single-ride link.
--
-- WHY NOT NOT-NULL / NO DEFAULT
--   Almost every ride is shared on its own, and that must stay the cheapest case: NULL means
--   "shared by itself", which is what every existing row already is and what a newly created
--   ride is until an organizer connects it to something.
--
-- WHAT THIS FILE DOES NOT DECIDE
--   Which rides may be connected (same owner, at most 3, start times within one day of each
--   other) is a product rule and lives in the service, the same way sql/036 left "liking your
--   own track" to recordRouteCopy's neighbours. The schema only stores the grouping.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs, in either order.
--
--   Every event read in the server is SELECT * or SELECT e.* (queries/event.queries.ts -
--   selectActiveEventByCode, selectEventById, selectEventsForUser, selectPublicEvents, and
--   the RETURNING * on insert/update). EVENT_SUMMARY_COLUMNS names only the lateral-join
--   extras, never an event column. So this column simply arrives in the row once the file has
--   run, and before that mapEvent's `row.link_group_id ?? null` reads it as null - exactly how
--   country/region (sql/030) and elevation_gain_m (sql/021) already degrade.
--
--   The one write path (updateEventLinkGroup) is wrapped in the same missing-column guard the
--   other post-001 writers use: on 42703 it warns naming this file and returns, so connecting
--   rides is simply unavailable until the migration runs. No ride is touched and nothing a
--   rider did is lost.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/037-event-link-groups.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. One nullable column is added and one
-- index is created. No existing row is read or written, and nothing is dropped, renamed or
-- retyped. Every existing ride keeps link_group_id = NULL, which means "shared on its own" -
-- i.e. exactly today's behaviour.

------------------------------------------------------------------------------------------
-- 1. The column
------------------------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN IF NOT EXISTS link_group_id UUID;

COMMENT ON COLUMN events.link_group_id IS
    'Shared by the 2-3 rides that are shared under one /share link. NULL = shared on its own.';

------------------------------------------------------------------------------------------
-- 2. The index
------------------------------------------------------------------------------------------

-- Serves the share endpoint's only read: given one ride's group, fetch the whole group
--   SELECT * FROM events WHERE link_group_id = $1
-- PARTIAL on purpose. The overwhelming majority of rides are shared on their own and carry
-- NULL here; indexing those would be almost the whole table for no query's benefit.
CREATE INDEX IF NOT EXISTS idx_events_link_group
    ON events (link_group_id) WHERE link_group_id IS NOT NULL;

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name = 'link_group_id';
--   -- expect: link_group_id | uuid | YES
--
--   SELECT count(*) FROM events WHERE link_group_id IS NOT NULL;   -- expect 0
--   SELECT count(*) FROM events;                                   -- expect unchanged
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'events' AND indexname = 'idx_events_link_group';
--   -- expect: idx_events_link_group
