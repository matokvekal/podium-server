-- audit-event-country.sql — READ-ONLY. Find historical rides that are NOT in Israel.
--
-- WHY
--   sql/030-country.sql backfilled every existing event to country = 'IL'. Almost all
--   historical rides are in Israel; a small number are in Sweden. This classifies each ride
--   by its attached route's START COORDINATE (no geocoder — just bounding boxes) so an
--   operator can eyeball the exceptions and correct only those.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/gilad/audit-event-country.sql
--   Nothing is written. Copy the non-IL rows out and confirm them before running any UPDATE.
--
-- BOXES (deliberately loose — 'OTHER — review' catches anything that is not clearly one or
-- the other, so no ride is silently mislabelled):
--   IL  lat 29.4 .. 33.4    lon 34.2 .. 35.95
--   SE  lat 55.0 .. 69.1    lon 10.5 .. 24.2   (also covers bits of NO/FI/DK — fine here,
--                                               the only known non-IL rides are Swedish)

\echo '== 1. every ride with a route, classified by its newest attached route start point =='

WITH ride_route AS (
    SELECT DISTINCT ON (er.event_id)
           er.event_id,
           r.id AS route_id,
           COALESCE(r.start_lat, (r.track_points -> 0 ->> 0)::double precision) AS start_lat,
           COALESCE(r.start_lon, (r.track_points -> 0 ->> 1)::double precision) AS start_lon,
           r.place_name,
           r.source
      FROM event_routes er
      JOIN routes r ON r.id = er.route_id
     ORDER BY er.event_id, er.created_at DESC
),
classified AS (
    SELECT e.id            AS event_id,
           e.code          AS event_code,
           e.name          AS event_name,
           e.starts_at,
           e.country       AS current_country,
           rr.route_id,
           round(rr.start_lat::numeric, 5) AS start_lat,
           round(rr.start_lon::numeric, 5) AS start_lon,
           rr.place_name,
           rr.source,
           CASE
             WHEN rr.start_lat IS NULL OR rr.start_lon IS NULL THEN 'UNKNOWN — no coords'
             WHEN rr.start_lat BETWEEN 29.4 AND 33.4
              AND rr.start_lon BETWEEN 34.2 AND 35.95           THEN 'IL'
             WHEN rr.start_lat BETWEEN 55.0 AND 69.1
              AND rr.start_lon BETWEEN 10.5 AND 24.2            THEN 'SE'
             ELSE 'OTHER — review'
           END AS detected_country
      FROM events e
      JOIN ride_route rr ON rr.event_id = e.id
)
SELECT event_id, event_code, event_name, starts_at, current_country,
       route_id, start_lat, start_lon, place_name, source, detected_country
  FROM classified
 -- non-IL first, so the exceptions are at the top of the output
 ORDER BY (detected_country = 'IL'), detected_country, event_name;

\echo ''
\echo '== 2. summary counts =='

WITH ride_route AS (
    SELECT DISTINCT ON (er.event_id) er.event_id,
           COALESCE(r.start_lat, (r.track_points -> 0 ->> 0)::double precision) AS start_lat,
           COALESCE(r.start_lon, (r.track_points -> 0 ->> 1)::double precision) AS start_lon
      FROM event_routes er JOIN routes r ON r.id = er.route_id
     ORDER BY er.event_id, er.created_at DESC
)
SELECT CASE
         WHEN start_lat IS NULL OR start_lon IS NULL THEN 'UNKNOWN — no coords'
         WHEN start_lat BETWEEN 29.4 AND 33.4 AND start_lon BETWEEN 34.2 AND 35.95 THEN 'IL'
         WHEN start_lat BETWEEN 55.0 AND 69.1 AND start_lon BETWEEN 10.5 AND 24.2  THEN 'SE'
         ELSE 'OTHER — review'
       END AS detected_country,
       count(*)
  FROM events e
  JOIN ride_route rr ON rr.event_id = e.id
 GROUP BY 1
 ORDER BY 2 DESC;

\echo ''
\echo '== 3. rides with NO route — cannot be classified, stay IL unless you know otherwise =='

SELECT e.id AS event_id, e.code AS event_code, e.name AS event_name, e.starts_at, e.country
  FROM events e
 WHERE NOT EXISTS (SELECT 1 FROM event_routes er WHERE er.event_id = e.id)
 ORDER BY e.starts_at;

\echo ''
\echo '== 4. ready-made UPDATE for the Sweden rides — REVIEW section 1 FIRST, then run this =='
\echo '   (prints the statement; it does not execute it)'

WITH ride_route AS (
    SELECT DISTINCT ON (er.event_id) er.event_id,
           COALESCE(r.start_lat, (r.track_points -> 0 ->> 0)::double precision) AS start_lat,
           COALESCE(r.start_lon, (r.track_points -> 0 ->> 1)::double precision) AS start_lon
      FROM event_routes er JOIN routes r ON r.id = er.route_id
     ORDER BY er.event_id, er.created_at DESC
),
se AS (
    SELECT e.id
      FROM events e
      JOIN ride_route rr ON rr.event_id = e.id
     WHERE rr.start_lat BETWEEN 55.0 AND 69.1
       AND rr.start_lon BETWEEN 10.5 AND 24.2
)
SELECT CASE WHEN count(*) = 0
            THEN '-- no Sweden rides detected'
            ELSE format(
              'UPDATE events SET country = ''SE'', updated_at = NOW() WHERE id IN (%s);',
              string_agg(quote_literal(id::text), ', ')
            )
       END AS update_statement
  FROM se;
