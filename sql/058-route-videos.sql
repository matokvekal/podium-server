-- 058-route-videos.sql — a short "flyover" video attached to a track (routes.id).
--
--   route_videos(route_id, ext, byte_length, duration_s, updated_at)
--
-- WHY THIS EXISTS
--   A track owner can attach one short video (max 2 MB) of the track — the Tour-de-France /
--   Strava style flyover. Every ride that uses the track shows the same video to logged-in
--   riders on the ride page.
--
-- WHERE THE BYTES LIVE
--   NOT in the database: on disk under ROUTE_VIDEOS_DIR as "{route_id}.{ext}"
--   (lib/route-video-storage.ts), outside the deployment directory and never in git. This table
--   is only the metadata the ride page needs to draw the "▶ Video 0:42" button without touching
--   the file.
--
-- WHY A SEPARATE TABLE (NOT COLUMNS ON routes)
--   Same reasoning as route_gpx_files (sql/042): routes is read with SELECT * and a spelled-out
--   column list on hot paths; keeping this apart means none of those change, and a database
--   without this file degrades to "no track has a video" (42P01 is swallowed on read).
--
-- SHAPE NOTES
--   No foreign key — this schema has none anywhere (sql/README.md). route_id is the primary key:
--   one video per track; a replace is an UPDATE of the same row.
--   duration_s is what the uploader's browser measured — display only, never trusted for anything.
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs: reads treat a missing table as
--   "no video", and an upload against a database without it fails with a clear 500.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/058-route-videos.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: a new table that starts empty.

CREATE TABLE IF NOT EXISTS route_videos (
    route_id    BIGINT      PRIMARY KEY,
    ext         TEXT        NOT NULL CHECK (ext IN ('mp4', 'webm', 'mov')),
    byte_length INTEGER     NOT NULL CHECK (byte_length > 0),
    duration_s  INTEGER     CHECK (duration_s IS NULL OR duration_s BETWEEN 1 AND 600),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
