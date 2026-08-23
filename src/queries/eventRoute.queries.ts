// SQL for THE ROUTE ATTACHED TO AN EVENT — the `event_routes` join table, plus the one
// insert that stores a hand-drawn/copied line so it can be attached.
//
//   /api/v1/events/:eventId/route   ->  this file
//   /api/v1/routes/*                ->  routeLibrary.queries.ts
//
// Both files touch the `routes` table, because an event's route IS a row in the route
// library — `event_routes` only says which one. The split is by URL surface, which is what
// you are searching by when you land here.
//
// ┌─ READ THIS BEFORE TOUCHING track_points ────────────────────────────────────────────────┐
// │ The `routes.track_points` column is read in TWO different shapes in this codebase:      │
// │                                                                                          │
// │   this file            -> RoutePoint  = [lat, lng]      (tuples)                         │
// │   routeLibrary.queries -> TrackPoint  = { lat, lng, … } (objects)                        │
// │                                                                                          │
// │ That is pre-existing and is a real latent bug: a route written through the library and   │
// │ read back through GET /events/:eventId/route comes out as objects where the client's     │
// │ EventRoute type expects tuples (and vice versa). It is NOT fixed here because either     │
// │ mapper changing alters a live API response body. See the refactor notes / PROBLEMS.md.  │
// └──────────────────────────────────────────────────────────────────────────────────────────┘

import { execute, queryOne, withTransaction } from "../db/pool.js";
import {
  mapRouteWithOwner,
  ROUTE_OWNER_COLUMN,
  ROUTE_SUMMARY_COLUMNS,
  // Aliased: this file has its own RouteRow for the tuple-geometry projection.
  type RouteRow as RouteLibraryRow,
  type RouteWithOwner,
} from "./routeLibrary.queries.js";

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
 * Inserts a new library row for a client-drawn/copied route, so it can then be attached to an
 * event. `source = 'drawn'` is the closest fit among the column's documented values
 * (gpx|tcx|geojson|json|drawn|copied) for a client-picked route with no real file behind it.
 * name, route_type, markers, preview_points, place_name, start/end lat/lon and bbox_* are all
 * left null; is_public defaults to FALSE.
 *
 * Named ...Row, and separate from routeLibrary's insertRoute, because it writes the tuple
 * geometry shape — see the track_points warning at the top of this file.
 */
export async function insertDrawnRouteRow(
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
  if (!row) throw new Error("insertDrawnRouteRow returned no row");
  return mapStoredRoute(row);
}

/**
 * Replaces whatever route is currently attached to the event: deletes any existing
 * event_routes row(s) for `eventId`, then attaches `routeId`. V1 is one active route per event
 * — re-saving a route should replace it, not accumulate — done in a transaction so a failure
 * never leaves the event pointing at nothing (deleted the old link but failed to insert the
 * new one).
 *
 * This is the ONLY attach in the codebase. There used to be a second, non-transactional copy
 * (route.queries.ts's replaceEventRoute) reached by the other half of POST /:eventId/route;
 * both did the same thing, so they were collapsed onto this, the safer one.
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

/**
 * The event's route as bare geometry — { points, distanceKm, elevationM }, tuple shape.
 * This is what GET /api/v1/events/:eventId/route returns.
 *
 * Newest link wins (only matters if V1's one-route invariant is ever violated out from under
 * this code, e.g. by a manual DB edit).
 */
export async function selectEventRouteGeometry(eventId: string): Promise<EventRoute | null> {
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

/**
 * The event's route as the detail page needs it: a browse-card summary (preview geometry
 * only, plus the owner's name). The full line is a second call to GET /routes/:routeId,
 * exactly as the browse cards work.
 *
 * Distinct from selectEventRouteGeometry above: same join, different projection and a
 * different track_points shape. This one feeds the `route` field of the event detail payload.
 */
export async function selectEventRouteSummary(eventId: string): Promise<RouteWithOwner | null> {
  const row = await queryOne<RouteLibraryRow>(
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

/** Detaches the event's route. Returns false when there was nothing attached. */
export async function deleteEventRoute(eventId: string): Promise<boolean> {
  return (await execute("DELETE FROM event_routes WHERE event_id = $1", [eventId])) > 0;
}

/** Run before deleting a library route: there are no foreign keys, so nothing else clears these. */
export async function deleteEventRoutesForRoute(routeId: number): Promise<void> {
  await execute("DELETE FROM event_routes WHERE route_id = $1", [routeId]);
}
