-- 026-route-copies-backfill.sql — seed route_copies from the track reuse that already happened.
--
-- SEPARATE FROM sql/025 ON PURPOSE. 025 creates schema and touches no existing row. This file
-- WRITES DATA derived from live tables, which is a different kind of risk and deserves its own
-- decision. Run 025 first, verify it, then decide about this one.
--
-- WHAT IT DOES
--   Every row in event_routes where the ride's owner is not the track's owner IS a ride someone
--   built on someone else's track — the exact fact route_copies stores. Without this, every
--   track starts at 0 and the "Downloads" number on a well-used track reads as a lie on day one.
--
-- WHAT IT CANNOT RECOVER, and will not pretend to
--   * source_event_id is left NULL for every backfilled row. These links record WHICH TRACK a
--     ride used, never which ride it was copied from — that fact was never stored. An honest
--     NULL beats an invented id; NULL already has a defined meaning here ("no source ride"),
--     which is what a Find Tracks copy writes.
--   * Copies made before this change FORKED the track instead of linking it (the client POSTed
--     the geometry back as a new row — see the plan and eventRoute.queries.ts insertDrawnRouteRow).
--     Those produced a brand-new routes row with no link to the original and no recoverable
--     trace of it. They are NOT counted here and cannot be. The seeded number is therefore a
--     floor, not a reconstruction, and it only counts the Find Tracks path that already linked
--     properly.
--   * created_at is copied from the event_routes link, so the ledger keeps the real date of the
--     reuse rather than the date this file was run.
--
-- WHO IS EXCLUDED
--   * e.owner_id IS NULL — legacy events with no owner (owner_id was added in sql/016); there
--     is no user to credit the copy to, and copied_by_user_id is NOT NULL.
--   * r.owner_id IS DISTINCT FROM e.owner_id — an organizer using their OWN track is not a
--     copy. IS DISTINCT FROM, not <>, so a track with a NULL owner still counts as "not mine"
--     rather than dropping out on a NULL comparison.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/026-route-copies-backfill.sql
--
-- SAFE TO RUN MORE THAN ONCE. ON CONFLICT DO NOTHING against route_copies_route_event_key means
-- a second run inserts 0 rows. It only ever INSERTs — nothing is updated or deleted.
--
-- HOW TO UNDO
--   Run this immediately after 025, while route_copies is still empty (`SELECT count(*)` = 0
--   before you start). Then the complete undo is:
--       DELETE FROM route_copies;
--   Once real traffic has written rows, that is no longer safe and the undo becomes
--       DELETE FROM route_copies WHERE source_event_id IS NULL AND created_at < '<run time>';
--   which is why running it before the server ships is the easy path.

-- Count what WOULD be inserted before inserting it (run this on its own first):
--   SELECT count(*)
--     FROM event_routes er
--     JOIN events e ON e.id = er.event_id
--     JOIN routes r ON r.id = er.route_id
--    WHERE e.owner_id IS NOT NULL
--      AND r.owner_id IS DISTINCT FROM e.owner_id;

INSERT INTO route_copies (route_id, copied_by_user_id, new_event_id, source_event_id, created_at)
SELECT er.route_id,
       e.owner_id,
       er.event_id,
       NULL,          -- never knowable for a backfilled row; see the header
       er.created_at
  FROM event_routes er
  JOIN events e ON e.id = er.event_id
  JOIN routes r ON r.id = er.route_id
 WHERE e.owner_id IS NOT NULL
   AND r.owner_id IS DISTINCT FROM e.owner_id
ON CONFLICT (route_id, new_event_id) DO NOTHING;

-- Verify afterwards:
--   SELECT count(*) FROM route_copies;                        -- matches the pre-count above
--   SELECT count(*) FROM route_copies WHERE source_event_id IS NOT NULL;  -- expect 0
--   SELECT route_id, count(*) AS used_by_rides
--     FROM route_copies GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
--
-- Then run this whole file a SECOND time: it must insert 0 rows and leave the counts unchanged.
