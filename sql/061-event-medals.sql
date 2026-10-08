-- 061-event-medals.sql — Event Completion Medals.
--
--   events.medal_enabled   boolean NOT NULL DEFAULT false
--   events.medal_text      text NULL (the organizer's dedication, ≤30 words — checked by the app)
--   event_medal_awards     one row per (ride, rider) who received the ride's medal
--
-- WHY THIS EXISTS
--   An organizer may give every rider of a ride a completion medal with a short dedication.
--   When the ride finishes (organizer's Finish, or the auto-finish sweeper) each rider who rode
--   it gets ONE medal (src/services/eventMedals.service.ts). A medal is permanent history, so
--   the award row SNAPSHOTS the ride's name, date and dedication: editing or reopening the ride
--   later never re-words a medal already given. Separate from the Statistics gems, which are
--   recomputed totals and store nothing.
--
--   No foreign keys, like every table here (sql/README.md). Rides are never hard-deleted
--   (cancel is a status), so a medal never points at a vanished ride; it would still render
--   from its own snapshot if one did.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs. Without it: mapEvent reads
--   the missing columns as "no medal", the medal switch is skipped with a warning, awards are a
--   logged no-op, and the medals list / unseen count read as empty. Nothing else changes.
--   Every existing ride gets medal_enabled = false: it behaves exactly as before.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/061-event-medals.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: IF NOT EXISTS everywhere; a constant
-- DEFAULT on ADD COLUMN is metadata-only (PostgreSQL 11+), so `events` is not rewritten; the new
-- table starts empty.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS medal_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS medal_text TEXT
    CONSTRAINT chk_events_medal_text_length
        CHECK (medal_text IS NULL OR char_length(medal_text) <= 600);

-- The medal's background, picked by the organizer: one colour id + one style id (the app's
-- src/lib/medal-text.ts lists them). NULL = the original look. Never an image.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS medal_color_id VARCHAR(32);

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS medal_style_id VARCHAR(32);

CREATE TABLE IF NOT EXISTS event_medal_awards (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        UUID         NOT NULL,           -- events.id
    user_id         BIGINT       NOT NULL,           -- users.id — the rider who holds the medal
    event_title     TEXT         NOT NULL,           -- snapshot of events.name at award time
    event_date      TIMESTAMPTZ  NOT NULL,           -- snapshot: COALESCE(starts_at, finished_at)
    medal_text      TEXT         NOT NULL,           -- snapshot of the dedication
    medal_color_id  VARCHAR(32)  NULL,               -- snapshot of the background colour id
    medal_style_id  VARCHAR(32)  NULL,               -- snapshot of the background style id
    awarded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    seen_at         TIMESTAMPTZ  NULL                -- NULL = the rider has not opened it yet
);

-- Idempotency: one medal per rider per ride, whatever retries / sweeps / nodes run the award
-- (INSERT ... ON CONFLICT (event_id, user_id) DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_medal_awards_event_user
    ON event_medal_awards (event_id, user_id);

-- GET /api/v1/medals/me — a rider's medals newest first, keyset-paged on (awarded_at, id); also
-- serves the my-rides "which of these rides have my medal" lookup by user_id.
CREATE INDEX IF NOT EXISTS idx_event_medal_awards_user_newest
    ON event_medal_awards (user_id, awarded_at DESC, id DESC);

-- The profile's unseenMedalCount (GET /api/v1/users/me) — only the few unseen rows.
CREATE INDEX IF NOT EXISTS idx_event_medal_awards_user_unseen
    ON event_medal_awards (user_id) WHERE seen_at IS NULL;

-- VERIFY
--   SELECT column_name, data_type, column_default FROM information_schema.columns
--    WHERE table_name = 'events' AND column_name IN ('medal_enabled', 'medal_text');
--   SELECT indexname FROM pg_indexes WHERE tablename = 'event_medal_awards' ORDER BY 1;
--   -- expect: event_medal_awards_pkey, idx_event_medal_awards_user_newest,
--   --         idx_event_medal_awards_user_unseen, uq_event_medal_awards_event_user
