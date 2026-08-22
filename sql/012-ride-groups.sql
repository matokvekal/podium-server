-- 012-ride-groups.sql — 2-4 groups riding ONE event together (e.g. "Beginners" at 07:00 and
-- "Elite" at 06:00), each optionally on its own track.
--
-- This is not a results or category concept and must not be confused with one:
-- event_participants.category is "which class am I scored in", a group is "who am I riding
-- with". A club running one Saturday ride as two paces has two groups, not two events, and
-- nobody is placed against the other group.
--
-- Until now this lived entirely in the browser (podium-client/src/store/eventGroupsStore.ts,
-- localStorage), so a fully built screen — paging between groups, bulk-assigning riders,
-- per-group start times and tracks — persisted nowhere. A rider added to a group on the
-- organizer's phone did not exist on anyone else's.
--
-- Safe to run on the live database: every statement is additive.

CREATE TABLE IF NOT EXISTS event_groups (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   UUID NOT NULL,
    name       VARCHAR(120) NOT NULL,

    -- Independent of events.starts_at on purpose: a club can run "Elite" at 06:00 and
    -- "Masters" at 07:00 off one event. NULL means "same as the event".
    starts_at  TIMESTAMPTZ,

    -- Optional own track. NULL falls back to the event's route (event_routes).
    route_id   BIGINT,

    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every group of one event, in the order the groups screen pages through them.
CREATE INDEX IF NOT EXISTS idx_event_groups_event ON event_groups (event_id, sort_order);

-- Which group a rider is in. NULL = not assigned to any group, which is the normal state for
-- an event that never uses them.
ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS group_id BIGINT;

-- "Who is in this group" on the groups screen. Partial: most participants have no group.
CREATE INDEX IF NOT EXISTS idx_event_participants_group
    ON event_participants (group_id) WHERE group_id IS NOT NULL;
