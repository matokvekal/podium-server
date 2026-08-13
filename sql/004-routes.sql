-- 004-routes.sql — routes, stored independently of any event so one route can serve many
-- events and be published to the public library.
--
-- Everything from distance_km down to bbox_max_lon is computed once by the route parser at
-- upload time, so browsing the library never has to open the full geometry.

CREATE TABLE IF NOT EXISTS routes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT,
    name VARCHAR(255),
    route_type VARCHAR(50),          -- road | gravel | mtb | mixed
    source VARCHAR(50),              -- gpx | tcx | geojson | json | drawn | copied

    distance_km DOUBLE PRECISION,
    elevation_m DOUBLE PRECISION,

    track_points JSONB,              -- full geometry [[lat, lng], ...]
    markers JSONB,                   -- [{lat, lng, label, type}, ...]

    -- Small simplified copy. The public browser renders many map previews at once and must
    -- never load full geometry to do it.
    preview_points JSONB,
    point_count INT,

    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    place_name VARCHAR(255),         -- free text: "Galilee", "Ashkelon"
    start_lat DOUBLE PRECISION,
    start_lon DOUBLE PRECISION,
    end_lat DOUBLE PRECISION,
    end_lon DOUBLE PRECISION,
    bbox_min_lat DOUBLE PRECISION,
    bbox_min_lon DOUBLE PRECISION,
    bbox_max_lat DOUBLE PRECISION,
    bbox_max_lon DOUBLE PRECISION,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- My route library.
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes (owner_id);
-- Public route browser, newest first.
CREATE INDEX IF NOT EXISTS idx_routes_public
    ON routes (is_public, created_at DESC) WHERE is_public = TRUE;
-- Public route browser, "near this area".
CREATE INDEX IF NOT EXISTS idx_routes_public_start
    ON routes (start_lat, start_lon) WHERE is_public = TRUE;

CREATE TABLE IF NOT EXISTS event_routes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL,
    route_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The route(s) attached to an event, read on every event detail and live map view.
CREATE INDEX IF NOT EXISTS idx_event_routes_event ON event_routes (event_id);
