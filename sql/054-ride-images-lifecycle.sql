-- 054-ride-images-lifecycle.sql — Replace + Archive for the ride-cover registry (sql/052).
--
--   version     — bumped every time the image behind a key is replaced. The API appends
--                 "?v=<version>" to the resolved URL when version > 1, so a client that cached
--                 the old picture fetches the new one; the key never changes.
--   archived    — "Delete" in /admin2026 is an ARCHIVE: hidden from the admin list and from the
--                 picker, never physically removed. A ride that already wears the key keeps
--                 resolving it (GET /api/v1/ride-images still returns archived rows).
--   updated_at  — when the row last changed (replace / enable / archive).
--
-- Additive and idempotent; existing rows get version 1, archived false. The server tolerates
-- this migration not being applied yet (the catalog just reads as before) — but Replace and
-- Archive answer 503 until it has run.
ALTER TABLE ride_images ADD COLUMN IF NOT EXISTS version    INTEGER     NOT NULL DEFAULT 1;
ALTER TABLE ride_images ADD COLUMN IF NOT EXISTS archived   BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE ride_images ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
