-- 009-results.sql — the two result fields the client's results page already renders and the
-- server had nowhere to keep.
--
-- Everything else results needs already exists: event_participants carries result_status,
-- attendance_status, finished_at and finish_position (sql/003-participants.sql), and
-- participant_tracks carries the saved ride line (sql/005-tracking.sql).
--
-- ⚠ Place and category place are NOT stored. They are computed at read time in
-- results.service.ts, the same way computeEffectiveStatus derives an event's real status —
-- a stored rank drifts the moment one rider's finish time is corrected.
--
-- Safe to run on the live database: both statements are additive.

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS team          VARCHAR(120),
    ADD COLUMN IF NOT EXISTS country_code  CHAR(2);   -- ISO 3166-1 alpha-2, e.g. 'IL', 'FR'

-- The results endpoint orders finishers within one event. Partial, because the only rows it
-- ever ranks are the ones that actually finished.
CREATE INDEX IF NOT EXISTS idx_event_participants_finish
    ON event_participants (event_id, finish_position, finished_at)
    WHERE result_status = 'finished';
