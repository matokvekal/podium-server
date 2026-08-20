-- 013-teams-and-follows.sql — clubs with real membership, and following an organizer.
--
-- "Pro teams have rides a few times a week, some standard, some new tracks, all members can
-- see the schedule, sometimes I invite new riders and I approve them." A team is a real
-- linkable entity, not a free-text name, so its rides gather under one name — which a string
-- in events.organizer_group cannot do.
--
-- Both features were entirely client-side before this (podium-client/src/store/teamsStore.ts,
-- localStorage): a member added on the organizer's phone existed on no other device, and
-- "follow this creator" existed on neither side.
--
-- Safe to run on the live database: every statement is additive.

CREATE TABLE IF NOT EXISTS teams (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    owner_id    BIGINT NOT NULL,
    avatar_url  VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "My teams", and the per-owner cap the free plan applies.
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id);

-- Mirrors event_participants deliberately: a member may have no account yet, because they
-- were added by hand, from a spreadsheet, or from phone contacts.
CREATE TABLE IF NOT EXISTS team_members (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id    BIGINT NOT NULL,
    user_id    BIGINT,                     -- NULL until they sign up
    name       VARCHAR(200),
    email      VARCHAR(255),
    phone      VARCHAR(100),
    -- invited | waiting_approval | approved | rejected. An organizer-added member is
    -- approved outright: the direct add IS the approval.
    status     VARCHAR(30) NOT NULL DEFAULT 'invited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The roster for one team.
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
-- "Teams I belong to", for a signed-in rider.
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
-- One row per real account per team. NULLs count as distinct, so any number of
-- account-less members coexist while a real user cannot be added twice — the same trick
-- event_participants_event_id_user_id_key uses.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_id_user_id_key
    ON team_members (team_id, user_id);

-- A ride belonging to a team's schedule. events.organizer_group stays as the display string
-- for rides that are not part of an ongoing schedule.
ALTER TABLE events ADD COLUMN IF NOT EXISTS team_id BIGINT;

-- "This team's rides".
CREATE INDEX IF NOT EXISTS idx_events_team ON events (team_id) WHERE team_id IS NOT NULL;

-- "Follow this creator and see their future rides."
CREATE TABLE IF NOT EXISTS user_follows (
    follower_id BIGINT NOT NULL,
    followee_id BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);

-- The primary key already answers "who do I follow". This one answers the other direction:
-- "who follows me", and the follower count on an organizer's rides.
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows (followee_id);
