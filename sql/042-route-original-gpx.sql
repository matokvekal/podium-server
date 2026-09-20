-- 042-route-original-gpx.sql — the ORIGINAL GPX file of a track, byte for byte, for download.
--
--   route_gpx_files(route_id, content BYTEA, sha256, byte_length, filename, created_at)
--
-- WHY THIS EXISTS
--   Until now the app never kept the file a track came from. routes.track_points holds parsed (and,
--   for imported tracks, simplified) geometry, and the GPX a rider downloads is REBUILT from it in
--   the browser (client lib/track-gpx.ts buildGpxFile). For a library of curated tracks that is
--   the wrong thing to hand out: the rebuilt file loses the original's waypoints, extra <trk>
--   pieces, timestamps and every point the display line dropped.
--
--   This table keeps the source file exactly as it arrived so the download can be the real one.
--   The stored geometry stays a separate, smaller, display-only representation.
--
-- WHY A SEPARATE TABLE (NOT A COLUMN ON routes)
--   routes is read with SELECT * on hot paths (library lists, event route reads). A multi-megabyte
--   BYTEA on that row would ride along on every one. Here it is only ever read by the one download
--   endpoint (GET /routes/:routeId/gpx), by primary key.
--
-- INTEGRITY
--   sha256 is of the stored bytes; the importer compares it against the source file's hash after
--   the write and refuses to call a track imported until they match. byte_length lets a reader
--   check the stored size without fetching the content.
--
-- SHAPE NOTES
--   No foreign key — this schema has none anywhere (sql/README.md). route_id is the primary key:
--   one original file per route, and an import can never silently overwrite one (the insert has no
--   ON CONFLICT ... DO UPDATE).
--
-- BACKWARDS COMPATIBILITY
--   Safe to deploy the server code BEFORE OR AFTER this file runs. The download endpoint answers
--   404 for a route with no stored file (every existing route) or a database without this table,
--   and the client then falls back to the rebuilt GPX it has always offered.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/042-route-original-gpx.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: a new table that starts empty.

CREATE TABLE IF NOT EXISTS route_gpx_files (
    route_id    BIGINT PRIMARY KEY,
    content     BYTEA NOT NULL,
    sha256      CHAR(64) NOT NULL,
    byte_length INT NOT NULL,
    filename    VARCHAR(255),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verify afterwards:
--   SELECT COUNT(*) FROM route_gpx_files;   -- 0 right after this runs
