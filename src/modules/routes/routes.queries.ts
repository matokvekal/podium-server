// SQL for routes and event_routes (sql/004-routes.sql). No SQL lives anywhere else in this
// module.
//
// The `routes` table backs a full route-library feature (public browsing, GPX/TCX parsing,
// markers, simplified previews) that is out of scope here — V1 only ever writes the columns
// this module actually needs (owner_id, source, distance_km, elevation_m, track_points,
// point_count) and leaves the rest (name, route_type, markers, preview_points, is_public,
// place_name, start/end lat/lon, bbox_*) unset. track_points is stored exactly as the column
// comment documents: full geometry as `[[lat, lng], ...]`, which is already the client's
// EventRoute.points shape — no reshaping needed in either direction.

import { queryOne, withTransaction } from "../../db/pool.js";

export type RoutePoint = [number, number];

interface RouteRow {
  id: number;
  track_points: RoutePoint[] | null;
  distance_km: number | null;
  elevation_m: number | null;
}

/** The row as stored, including its id — needed by setEventRoute to attach it to the event. */
export interface StoredRoute {
  id: number;
  points: RoutePoint[];
  distanceKm: number;
  elevationM: number | null;
}

/** What the client's EventRoute type expects — the exact contract this module hands back. */
export interface EventRoute {
  points: RoutePoint[];
  distanceKm: number;
  elevationM: number | null;
}

function mapStoredRoute(row: RouteRow): StoredRoute {
  return {
    id: row.id,
    points: row.track_points ?? [],
    // distance_km is nullable at the column level (the table also serves file-derived routes
    // with no known distance yet), but this module always supplies one on insert.
    distanceKm: row.distance_km ?? 0,
    elevationM: row.elevation_m,
  };
}

/** Strips `id` off a StoredRoute — the public API contract is exactly { points, distanceKm,
 * elevationM }, matching the client's EventRoute type, nothing extra. */
function mapEventRoute(row: RouteRow): EventRoute {
  const { id: _id, ...eventRoute } = mapStoredRoute(row);
  return eventRoute;
}

/**
 * Inserts a new library row for a client-drawn/copied route. `source = 'drawn'` is the closest
 * fit among the column's documented values (gpx|tcx|geojson|json|drawn|copied) for a
 * client-picked route with no real file behind it. name, route_type, markers, preview_points,
 * place_name, start/end lat/lon and bbox_* are all left null; is_public defaults to FALSE.
 */
export async function insertRoute(
  ownerId: number,
  points: RoutePoint[],
  distanceKm: number,
  elevationM: number | null,
): Promise<StoredRoute> {
  const row = await queryOne<RouteRow>(
    `INSERT INTO routes (owner_id, source, distance_km, elevation_m, track_points, point_count)
      VALUES ($1, 'drawn', $2, $3, $4::jsonb, $5)
      RETURNING id, track_points, distance_km, elevation_m`,
    [ownerId, distanceKm, elevationM, JSON.stringify(points), points.length],
  );
  if (!row) throw new Error("insertRoute returned no row");
  return mapStoredRoute(row);
}

/**
 * Replaces whatever route is currently attached to the event: deletes any existing
 * event_routes row(s) for `eventId`, then attaches `routeId`. V1 is one active route per event
 * — re-saving a route should replace it, not accumulate — done in a transaction so a failure
 * never leaves the event pointing at nothing (deleted the old link but failed to insert the
 * new one).
 */
export async function attachRouteToEvent(eventId: string, routeId: number): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query("DELETE FROM event_routes WHERE event_id = $1", [eventId]);
    await tx.query("INSERT INTO event_routes (event_id, route_id) VALUES ($1, $2)", [
      eventId,
      routeId,
    ]);
  });
}

/** The event's currently attached route, if any — newest link wins (only matters if V1's
 * one-route invariant is ever violated out from under this code, e.g. by a manual DB edit). */
export async function selectRouteForEvent(eventId: string): Promise<EventRoute | null> {
  const row = await queryOne<RouteRow>(
    `SELECT r.id, r.track_points, r.distance_km, r.elevation_m
       FROM event_routes er
       JOIN routes r ON r.id = er.route_id
      WHERE er.event_id = $1
      ORDER BY er.created_at DESC
      LIMIT 1`,
    [eventId],
  );
  return row ? mapEventRoute(row) : null;
}
