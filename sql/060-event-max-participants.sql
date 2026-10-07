-- 060-event-max-participants.sql — a per-ride rider cap the System Admin can set.
--
--   events.max_participants  integer NULL, > 0 when set
--
-- WHY THIS EXISTS
--   The rider cap belongs to the organizer's ACCOUNT (user_limits.participants_per_event), so
--   every ride an organizer makes shares one ceiling. A few big rides need far more than that
--   without raising the organizer's cap on every other ride. The admin sets this column from
--   /admin2026 (PATCH /api/v1/admin/rides/:eventId).
--
--   NULL = no override: the owner's account cap applies, exactly as before. A number replaces
--   ONLY the ceiling — who counts toward it (approved + still-pending, authz/participant-
--   capacity.ts) does not change.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs for the rider paths: mapEvent
--   reads a missing column as NULL (no override). The admin rides list needs this column and
--   will error until it exists.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/060-event-max-participants.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: a nullable column with no default, so no
-- table rewrite and every existing ride keeps its current cap.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS max_participants INTEGER
    CONSTRAINT chk_events_max_participants_positive
        CHECK (max_participants IS NULL OR max_participants > 0);
