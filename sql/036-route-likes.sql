-- 036-route-likes.sql — likes and favourites on a TRACK.
--
--   * route_likes      — append-only. One row per (track, rider who liked it).
--   * route_favorites  — a toggle. One row per (track, rider who bookmarked it).
--
-- WHY THIS EXISTS
--   Find Tracks became a real browsing surface: every signed-in rider can now open /routes and
--   scroll the library, not just an organizer part-way through creating a ride. Browsing needs
--   two things the app had no way to record:
--
--     1. "how many people rate this track"  — a public number, one per track, that helps a
--        rider choose between two lines they know nothing about;
--     2. "keep this one for me"             — a private bookmark, so a rider can come back to
--        a shortlist instead of re-finding it through the filters.
--
--   These are DIFFERENT THINGS and they are deliberately two tables, not one column with a
--   type. A like is public, permanent and counted; a favourite is private, reversible and only
--   ever read for one rider. Merging them would force every count query to filter by kind and
--   would make "unfavourite" look like it could remove a like.
--
-- WHY THE LIKE IS APPEND-ONLY
--   Same rule as route_copies (sql/025) and user limits (sql/018): the count is derived from
--   the rows, never stored, so it cannot drift — and the rows are only ever INSERTed, so the
--   count can only go up. A rider likes a track once. There is no unlike, and no UPDATE or
--   DELETE against route_likes should ever be written; the guard test in
--   queries/routeLike.queries.test.ts fails if one appears.
--
--   The FAVOURITE is the opposite and that is fine: it is the rider's own list, nobody counts
--   it, and removing a bookmark must actually remove it. DELETE is legal there and only there.
--
-- WHAT COUNTS AS ONE LIKE
--   One rider counts once against a given track, enforced by the unique index below rather than
--   by application logic — a double-tap, a retry, or an offline replay can then never
--   double-count no matter what the server does. Every insert is ON CONFLICT DO NOTHING.
--
--   Liking your own track is NOT blocked here. Whether that is allowed is a product rule, and
--   product rules live in the service (the way recordRouteCopy holds the "copying your own
--   track does not count" rule), not in the schema.
--
-- SHAPE NOTES
--   No foreign keys. This schema has none anywhere (sql/001-init.sql, sql/README.md); all
--   relational cleanup is application code. It matters here for the same reason it mattered in
--   sql/025: a like belongs to the TRACK and must outlive any one ride built on it.
--
--   route_id is BIGINT to match routes.id; user_id is BIGINT to match users.id.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs. The like/favourite counts
--   reach the public list through their own LEFT JOIN LATERAL, kept out of EVENT_SUMMARY_JOINS
--   exactly as copySummaryJoin is, so a 42P01 from this table missing falls to the same legacy
--   path that already covers route_copies — the list still serves, simply without the numbers.
--   The write endpoints answer 404/503-shaped errors rather than corrupting anything.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/036-route-likes.sql
--
-- SAFE ON LIVE DATA and safe to run more than once. Both tables start empty. Nothing is
-- dropped, renamed, retyped or deleted, and no existing row is read or written by this file.

------------------------------------------------------------------------------------------
-- 1. The append-only like ledger
------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS route_likes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id   BIGINT NOT NULL,  -- routes.id — the track being liked
    user_id    BIGINT NOT NULL,  -- users.id  — the rider who liked it
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE INTEGRITY RULE: one rider counts once against a given track, however many times the
-- button is pressed. Every insert relies on this via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS route_likes_route_user_key
    ON route_likes (route_id, user_id);

-- The counter read: SELECT COUNT(*) FROM route_likes WHERE route_id = $1, and the per-row
-- lateral behind the public list's like_count.
CREATE INDEX IF NOT EXISTS idx_route_likes_route ON route_likes (route_id);

------------------------------------------------------------------------------------------
-- 2. The rider's own bookmarks
------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS route_favorites (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id   BIGINT NOT NULL,  -- routes.id — the track bookmarked
    user_id    BIGINT NOT NULL,  -- users.id  — whose bookmark it is
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One bookmark per rider per track. Re-favouriting is a no-op, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS route_favorites_route_user_key
    ON route_favorites (route_id, user_id);

-- "show me only my favourites" — the filter reads every row for ONE user, so this index leads
-- with user_id, unlike route_likes which is always read per track.
CREATE INDEX IF NOT EXISTS idx_route_favorites_user ON route_favorites (user_id);

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT count(*) FROM route_likes;      -- expect 0
--   SELECT count(*) FROM route_favorites;  -- expect 0
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename IN ('route_likes', 'route_favorites') ORDER BY 1;
--   -- expect: idx_route_favorites_user, idx_route_likes_route, route_favorites_pkey,
--   --         route_favorites_route_user_key, route_likes_pkey, route_likes_route_user_key
