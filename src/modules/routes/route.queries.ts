// SQL for routes and event_routes. No SQL for this module lives anywhere else.
//
// The one rule that shapes every query here: a list NEVER selects track_points. The route
// browser paints a dozen map previews at once, and full geometry is the largest column in
// the database — see plan/08-routes-and-maps.md. Lists read preview_points; only
// selectRouteById opens the real line.

import { execute, query, queryOne } from "../../db/pool.js";
import type { Route, RouteMarker, RouteSource, RouteType, TrackPoint } from "../../db/types.js";

interface RouteRow {
  id: number;
  owner_id: number | null;
  name: string | null;
  route_type: RouteType | null;
  source: RouteSource | null;
  distance_km: number | null;
  elevation_m: number | null;
  /** Absent from every list query — see the file comment. */
  track_points?: TrackPoint[] | null;
  markers: RouteMarker[] | null;
  preview_points: TrackPoint[] | null;
  point_count: number | null;
  is_public: boolean;
  place_name: string | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  bbox_min_lat: number | null;
  bbox_min_lon: number | null;
  bbox_max_lat: number | null;
  bbox_max_lon: number | null;
  created_at: Date;
  updated_at: Date;
  /** Joined from users on the browse queries — the card shows "by Dani". */
  owner_name?: string | null;
}

/** Everything but track_points. Spelled out so a list can never accidentally select it. */
const ROUTE_SUMMARY_COLUMNS = `
  r.id, r.owner_id, r.name, r.route_type, r.source, r.distance_km, r.elevation_m,
  r.markers, r.preview_points, r.point_count, r.is_public, r.place_name,
  r.start_lat, r.start_lon, r.end_lat, r.end_lon,
  r.bbox_min_lat, r.bbox_min_lon, r.bbox_max_lat, r.bbox_max_lon,
  r.created_at, r.updated_at`;

const ROUTE_OWNER_COLUMN = `
  NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS owner_name`;

function mapRoute(row: RouteRow): Route {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    routeType: row.route_type,
    source: row.source,
    distanceKm: row.distance_km,
    elevationM: row.elevation_m,
    // undefined (a list query) and NULL (a route with no geometry) both mean "no line here" to
    // the caller, but only the second is a real answer — lists must not be mistaken for detail.
    trackPoints: row.track_points ?? null,
    markers: row.markers,
    previewPoints: row.preview_points,
    pointCount: row.point_count,
    isPublic: row.is_public,
    placeName: row.place_name,
    startLat: row.start_lat,
    startLon: row.start_lon,
    endLat: row.end_lat,
    endLon: row.end_lon,
    bboxMinLat: row.bbox_min_lat,
    bboxMinLon: row.bbox_min_lon,
    bboxMaxLat: row.bbox_max_lat,
    bboxMaxLon: row.bbox_max_lon,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A route as a browse card carries its owner's name; the Route type itself does not. */
export interface RouteWithOwner extends Route {
  ownerName: string | null;
}

function mapRouteWithOwner(row: RouteRow): RouteWithOwner {
  return { ...mapRoute(row), ownerName: row.owner_name ?? null };
}

export interface InsertRouteInput {
  ownerId: number;
  name: string | null;
  routeType: RouteType | null;
  source: RouteSource;
  placeName: string | null;
  isPublic: boolean;
  distanceKm: number | null;
  elevationM: number | null;
  trackPoints: TrackPoint[];
  markers: RouteMarker[] | null;
  previewPoints: TrackPoint[];
  pointCount: number;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  bboxMinLat: number | null;
  bboxMinLon: number | null;
  bboxMaxLat: number | null;
  bboxMaxLon: number | null;
}

export async function insertRoute(input: InsertRouteInput): Promise<Route> {
  const row = await queryOne<RouteRow>(
    `INSERT INTO routes
        (owner_id, name, route_type, source, distance_km, elevation_m,
         track_points, markers, preview_points, point_count, is_public, place_name,
         start_lat, start_lon, end_lat, end_lon,
         bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon)
      VALUES ($1, $2, $3, $4, $5, $6,
              $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12,
              $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *`,
    [
      input.ownerId,
      input.name,
      input.routeType,
      input.source,
      input.distanceKm,
      input.elevationM,
      JSON.stringify(input.trackPoints),
      input.markers === null ? null : JSON.stringify(input.markers),
      JSON.stringify(input.previewPoints),
      input.pointCount,
      input.isPublic,
      input.placeName,
      input.startLat,
      input.startLon,
      input.endLat,
      input.endLon,
      input.bboxMinLat,
      input.bboxMinLon,
      input.bboxMaxLat,
      input.bboxMaxLon,
    ],
  );
  if (!row) throw new Error("insertRoute returned no row");
  return mapRoute(row);
}

/** The only query that reads full geometry. */
export async function selectRouteById(routeId: number): Promise<RouteWithOwner | null> {
  const row = await queryOne<RouteRow>(
    `SELECT r.*, ${ROUTE_OWNER_COLUMN}
       FROM routes r
       LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.id = $1`,
    [routeId],
  );
  return row ? mapRouteWithOwner(row) : null;
}

/** "My routes" — public or not, newest first. */
export async function selectRoutesForOwner(ownerId: number): Promise<RouteWithOwner[]> {
  const rows = await query<RouteRow>(
    `SELECT ${ROUTE_SUMMARY_COLUMNS}, ${ROUTE_OWNER_COLUMN}
       FROM routes r
       LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.owner_id = $1
      ORDER BY r.created_at DESC`,
    [ownerId],
  );
  return rows.map(mapRouteWithOwner);
}

export interface PublicRouteFilters {
  place?: string;
  minDistance?: number;
  maxDistance?: number;
  minElevation?: number;
  maxElevation?: number;
  type?: RouteType;
  limit: number;
  offset: number;
}

/**
 * One statement with every filter written as "$n IS NULL OR <test>", rather than SQL
 * assembled at runtime — the same approach the COALESCE partial updates elsewhere take. It
 * keeps the statement a constant the fake DB and a reader can both check, and lets Postgres
 * cache one plan.
 *
 * The elevation tests deliberately do NOT match rows with a NULL elevation_m: "at least
 * 500 m of climb" must not return a route whose climb is unknown.
 */
export async function selectPublicRoutes(
  filters: PublicRouteFilters,
): Promise<{ routes: RouteWithOwner[]; total: number }> {
  const where = `r.is_public = TRUE
        AND ($1::text IS NULL OR r.place_name ILIKE '%' || $1 || '%' OR r.name ILIKE '%' || $1 || '%')
        AND ($2::double precision IS NULL OR r.distance_km >= $2)
        AND ($3::double precision IS NULL OR r.distance_km <= $3)
        AND ($4::double precision IS NULL OR r.elevation_m >= $4)
        AND ($5::double precision IS NULL OR r.elevation_m <= $5)
        AND ($6::text IS NULL OR r.route_type = $6)`;

  const params = [
    filters.place ?? null,
    filters.minDistance ?? null,
    filters.maxDistance ?? null,
    filters.minElevation ?? null,
    filters.maxElevation ?? null,
    filters.type ?? null,
  ];

  const rows = await query<RouteRow>(
    `SELECT ${ROUTE_SUMMARY_COLUMNS}, ${ROUTE_OWNER_COLUMN}
       FROM routes r
       LEFT JOIN users u ON u.id = r.owner_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT $7 OFFSET $8`,
    [...params, filters.limit, filters.offset],
  );

  // Paging a browser that pages needs the count; the client cannot know when to stop otherwise.
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM routes r WHERE ${where}`,
    params,
  );

  return { routes: rows.map(mapRouteWithOwner), total: Number(countRow?.count ?? 0) };
}

export async function updateRoute(
  routeId: number,
  input: { name?: string; routeType?: RouteType; placeName?: string; isPublic?: boolean },
): Promise<Route | null> {
  const rows = await query<RouteRow>(
    `UPDATE routes
        SET name = COALESCE($2, name),
            route_type = COALESCE($3, route_type),
            place_name = COALESCE($4, place_name),
            is_public = COALESCE($5, is_public),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      routeId,
      input.name ?? null,
      input.routeType ?? null,
      input.placeName ?? null,
      input.isPublic ?? null,
    ],
  );
  return rows[0] ? mapRoute(rows[0]) : null;
}

export async function deleteRoute(routeId: number): Promise<boolean> {
  return (await execute("DELETE FROM routes WHERE id = $1", [routeId])) > 0;
}

// ---- event_routes -----------------------------------------------------------------------

/**
 * One route per event: attaching replaces whatever was there. The table allows several rows
 * per event (it was designed with per-group tracks in mind — see the ride-groups work), but
 * nothing reads more than one yet, and silently accumulating rows would make "the event's
 * route" ambiguous the first time someone changes their mind.
 */
export async function replaceEventRoute(eventId: string, routeId: number): Promise<void> {
  await execute("DELETE FROM event_routes WHERE event_id = $1", [eventId]);
  await execute("INSERT INTO event_routes (event_id, route_id) VALUES ($1, $2)", [
    eventId,
    routeId,
  ]);
}

export async function deleteEventRoute(eventId: string): Promise<boolean> {
  return (await execute("DELETE FROM event_routes WHERE event_id = $1", [eventId])) > 0;
}

/** Run before deleting a route: there are no foreign keys, so nothing else clears these. */
export async function deleteEventRoutesForRoute(routeId: number): Promise<void> {
  await execute("DELETE FROM event_routes WHERE route_id = $1", [routeId]);
}

/**
 * The event's route as the detail page needs it: preview geometry only. The full line is a
 * second call to GET /routes/:id, exactly as the browse cards work.
 */
export async function selectRouteForEvent(eventId: string): Promise<RouteWithOwner | null> {
  const row = await queryOne<RouteRow>(
    `SELECT ${ROUTE_SUMMARY_COLUMNS}, ${ROUTE_OWNER_COLUMN}
       FROM event_routes er
       JOIN routes r ON r.id = er.route_id
       LEFT JOIN users u ON u.id = r.owner_id
      WHERE er.event_id = $1
      ORDER BY er.created_at DESC
      LIMIT 1`,
    [eventId],
  );
  return row ? mapRouteWithOwner(row) : null;
}
