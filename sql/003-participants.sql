-- 003-participants.sql — turn event_participants into a real start list.
--
-- ⚠ The id column is `participantId` in the frozen Android contract. Nothing here touches
-- it. Safe to run on the live database.

-- A participant must be allowed to have no account: manual entry and Excel import create
-- riders who have never opened the app.
ALTER TABLE event_participants ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS name VARCHAR(200),   -- used when there is no linked user
    ADD COLUMN IF NOT EXISTS email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS phone VARCHAR(100),
    ADD COLUMN IF NOT EXISTS category VARCHAR(80), -- races only

    -- THREE INDEPENDENT AXES. Do not merge them into one column: a rider can be approved
    -- AND present AND finished at the same time, which one column cannot express.
    -- registration_status: registered | waiting_approval | approved | rejected
    -- attendance_status:   unknown | present | dns | started
    -- result_status:       none | finished | dnf | stopped | unknown
    ADD COLUMN IF NOT EXISTS registration_status VARCHAR(30) NOT NULL DEFAULT 'registered',
    ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(30) NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS result_status VARCHAR(30) NOT NULL DEFAULT 'none',

    -- Basic results only: finish time and place. No laps, waves or category scoring in v1.
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finish_position INT;

-- Display name resolution is the application's job: event_participants.name when set,
-- otherwise the linked user's name. A rider with an account never retypes it per event.
