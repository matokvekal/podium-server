-- 010-event-profile.sql — three fields the create form has always collected and the server
-- has always thrown away.
--
-- Until now they lived in the browser (podium-client/src/store/eventExtrasStore.ts,
-- localStorage keyed by event id), which meant a ride's difficulty and organizing club were
-- visible ONLY in the browser that created it. Every other rider browsing that ride saw
-- nothing — which defeats the reason level was collected at all ("so a browsing rider can see
-- the hardness before joining").
--
-- Safe to run on the live database: every statement is additive.

ALTER TABLE events
    -- What kind of riding: road | mtb | gravel | running | hiking. Matches the client's
    -- SurfaceType. Distinct from events.type (RIDE | RACE), which is the frozen Android field.
    ADD COLUMN IF NOT EXISTS activity_type   VARCHAR(30),

    -- One difficulty label for the whole ride: beginner | intermediate | masters | elite |
    -- world_tour. Not a per-group thing — ride groups are their own feature.
    ADD COLUMN IF NOT EXISTS level           VARCHAR(30),

    -- Free-text club/team name shown as "Organized by". A real teams feature supersedes this
    -- later; the text field stays for rides that are not part of an ongoing schedule.
    ADD COLUMN IF NOT EXISTS organizer_group VARCHAR(200);

-- The public "Find Rides" list filters on these two together with status. Partial, because
-- only public events are ever browsed this way.
CREATE INDEX IF NOT EXISTS idx_events_public_browse
    ON events (activity_type, level)
    WHERE visibility = 'public';
