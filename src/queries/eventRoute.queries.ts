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
// │ Both shapes are now written ON PURPOSE by this file: a route whose upload carried a     │
// │ per-point elevation series is stored as objects, so the series has somewhere to live     │
// │ without widening the tuple (which is a live PWA contract). A route without elevation is  │
// │ still stored as tuples, byte for byte as before.                                         │
// │                                                                                          │
// │ The READ side is what keeps that safe: normalizeGeometry below projects either shape     │
// │ back to tuples plus a parallel elevation array, so GET /events/:eventId/route hands the   │
// │ client exactly the `points` it always did. Never read this column without it.            │
// └──────────────────────────────────────────────────────────────────────────────────────────┘

import { execute, queryOne, withTransaction } from "../db/pool.js";
import { simplifyByStride } from "../lib/geo.js";
import {
  mapRouteWithOwner,
  ROUTE_OWNER_COLUMN,
  ROUTE_SUMMARY_COLUMNS,
  // Aliased: this file has its own RouteRow for the tuple-geometry projection.
  type RouteRow as RouteLibraryRow,
  type RouteWithOwner,
} from "./routeLibrary.queries.js";

export type RoutePoint = [number, number];

/** Points kept in the card-sized preview line. Deliberately the same number as the route
 *  library's PREVIEW_POINT_TARGET (services/routeLibrary.service.ts) so both writers produce
 *  comparable previews — not imported from there, because a queries module importing a service
 *  inverts the layering and that service already imports its own queries. */
const PREVIEW_POINT_TARGET = 300;

/** What `routes.track_points` actually holds — see the box above. Deliberately loose: the
 *  normalizer is what turns it into something the API can hand out. */
type StoredPoint = unknown;

interface RouteRow {
  id: number;
  track_points: StoredPoint[] | null;
  distance_km: number | null;
  elevation_m: number | null;
}

/** The row as stored, including its id — needed by setEventRoute to attach it to the event. */
export interface StoredRoute {
  id: number;
  points: RoutePoint[];
  distanceKm: number;
  elevationM: number | null;
  elevations: (number | null)[] | null;
}

/** What the client's EventRoute type expects — the exact contract this module hands back. */
export interface EventRoute {
  points: RoutePoint[];
  distanceKm: number;
  elevationM: number | null;
  /** Present only when the stored geometry carried elevation. Omitted entirely otherwise, so
   *  the response body for every pre-existing route is unchanged. */
  elevations?: (number | null)[] | null;
}

/** The geometry handed to insertDrawnRouteRow: the line, and the elevation series when the
 *  upload had one. Kept as one value so the two can never be passed out of step. */
export interface RouteGeometry {
  points: RoutePoint[];
  elevations: (number | null)[] | null;
}

/**
 * Defensive read-side normalizer for the two-shapes problem described at the top of this file.
 *
 * `routes.track_points` genuinely holds both shapes: tuples [lat, lng] from insertDrawnRouteRow
 * below, objects {lat, lng, ele} from routeLibrary's insertRoute. This projection casts to
 * tuples, so an object-shaped route reaching GET /events/:eventId/route would hand the client
 * objects where its EventRoute type expects tuples — and the map would render nothing, with no
 * error anywhere to say why.
 *
 * It has never fired: nothing calls POST /routes today, so every stored row is tuple-shaped.
 * But "copy a track from another ride" now ATTACHES the original row instead of forking a fresh
 * tuple-shaped one, which means this read path can reach rows it never used to. Normalizing on
 * read costs one type check per point and removes the trap, rather than betting the feature on
 * the bug staying latent.
 *
 * Read-only: stored data is untouched, and this is a no-op for every row that exists today.
 */
function toRoutePoint(point: unknown): RoutePoint | null {
  if (Array.isArray(point)) {
    const [lat, lng] = point as [unknown, unknown];
    return typeof lat === "number" && typeof lng === "number" ? [lat, lng] : null;
  }
  if (typeof point === "object" && point !== null) {
    const { lat, lng } = point as { lat?: unknown; lng?: unknown };
    return typeof lat === "number" && typeof lng === "number" ? [lat, lng] : null;
  }
  return null;
}

/** The elevation stored on a point, if it has one. Tuple-shaped points never do. */
function toElevation(point: unknown): number | null {
  if (typeof point !== "object" || point === null || Array.isArray(point)) return null;
  const { ele } = point as { ele?: unknown };
  return typeof ele === "number" && Number.isFinite(ele) ? ele : null;
}

/**
 * Projects the stored column into the two arrays the API hands out.
 *
 * Both are built in ONE pass, and that is the point: a malformed point is dropped, and it has
 * to disappear from the elevation series at the same index or every later elevation would be
 * attributed to the wrong place on the route. `elevations` comes back null unless at least one
 * point actually carried a value, so a route stored as plain tuples reports "no elevation"
 * rather than an array of nulls.
 */
function normalizeGeometry(points: StoredPoint[] | null): RouteGeometry {
  if (!points) return { points: [], elevations: null };

  const normalized: RoutePoint[] = [];
  const elevations: (number | null)[] = [];
  let hasElevation = false;

  for (const point of points) {
    const tuple = toRoutePoint(point);
    // A point in neither shape is dropped rather than passed through as garbage the client
    // would try to draw. Dropping one point thins a line; passing it on breaks the map.
    if (!tuple) continue;
    normalized.push(tuple);

    const ele = toElevation(point);
    if (ele !== null) hasElevation = true;
    elevations.push(ele);
  }

  return { points: normalized, elevations: hasElevation ? elevations : null };
}

function mapStoredRoute(row: RouteRow): StoredRoute {
  const geometry = normalizeGeometry(row.track_points);
  return {
    id: row.id,
    points: geometry.points,
    elevations: geometry.elevations,
    // distance_km is nullable at the column level (the table also serves file-derived routes
    // with no known distance yet), but this module always supplies one on insert.
    distanceKm: row.distance_km ?? 0,
    elevationM: row.elevation_m,
  };
}

/** Strips `id` off a StoredRoute — the public API contract is exactly { points, distanceKm,
 * elevationM }, matching the client's EventRoute type, plus `elevations` when, and only when,
 * the stored geometry actually carried it. A route without elevation gets the identical body
 * it got before the profile existed. */
function mapEventRoute(row: RouteRow): EventRoute {
  const { id: _id, elevations, ...eventRoute } = mapStoredRoute(row);
  return elevations ? { ...eventRoute, elevations } : eventRoute;
}

/**
 * Inserts a new library row for a client-drawn/copied route, so it can then be attached to an
 * event. `source = 'drawn'` is the closest fit among the column's documented values
 * (gpx|tcx|geojson|json|drawn|copied) for a client-picked route with no real file behind it.
 * name, route_type, markers, place_name, start/end lat/lon and bbox_* are all left null;
 * is_public defaults to FALSE.
 *
 * preview_points IS written, which it never used to be. The Find Tracks card reads it to draw a
 * card-sized line and the elevation profile beneath it, and until now every route created this
 * way stored NULL there — so those cards had nothing to draw. Same thinning the route library
 * uses (simplifyByStride, PREVIEW_POINT_TARGET), applied to the same shape stored above so the
 * preview carries elevation whenever the full line does.
 *
 * Named ...Row, and separate from routeLibrary's insertRoute, because it owns the tuple
 * geometry shape — see the track_points warning at the top of this file. A route that came
 * with a per-point elevation series is stored as {lat, lng, ele} objects instead, which is the
 * other shape that box describes and which normalizeGeometry reads back.
 */
export async function insertDrawnRouteRow(
  ownerId: number,
  geometry: RouteGeometry,
  distanceKm: number,
  elevationM: number | null,
  isPublic: boolean,
): Promise<StoredRoute> {
  const { points, elevations } = geometry;
  // Tuples unless there is elevation to carry: an unchanged upload writes a byte-identical row.
  const stored: StoredPoint[] =
    elevations && elevations.length === points.length
      ? points.map(([lat, lng], i) => ({ lat, lng, ele: elevations[i] }))
      : points;
  const preview = simplifyByStride(stored, PREVIEW_POINT_TARGET);
  const row = await queryOne<RouteRow>(
    `INSERT INTO routes
        (owner_id, source, distance_km, elevation_m, track_points, preview_points,
         point_count, is_public)
      VALUES ($1, 'drawn', $2, $3, $4::jsonb, $5::jsonb, $6, $7)
      RETURNING id, track_points, distance_km, elevation_m`,
    [
      ownerId,
      distanceKm,
      elevationM,
      JSON.stringify(stored),
      JSON.stringify(preview),
      points.length,
      isPublic,
    ],
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
 * Just the id of the track attached to an event — no geometry, no owner join.
 *
 * This is what "copy the track from another ride" needs: the source ride's route id, so the new
 * ride can attach that same row (copyTrackFromEvent). Selecting the full geometry to throw all
 * of it away would move ~116 KB of JSON per copy for one BIGINT.
 *
 * Newest link wins, same ordering as selectEventRouteGeometry — only reachable if V1's
 * one-route-per-event invariant is violated out from under this code.
 */
export async function selectEventRouteId(eventId: string): Promise<number | null> {
  const row = await queryOne<{ route_id: number }>(
    `SELECT er.route_id
       FROM event_routes er
      WHERE er.event_id = $1
      ORDER BY er.created_at DESC
      LIMIT 1`,
    [eventId],
  );
  return row?.route_id ?? null;
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

/**
 * Publishes the track attached to a ride that has just become PUBLIC, so it reaches Find Tracks
 * straight away rather than waiting for the ride to happen — GET /routes/public still requires
 * `is_public = TRUE` as the owner's own intent, and a track saved while the ride was private
 * took the column default FALSE and had nothing to flip it back.
 *
 * OWNERSHIP IS ENFORCED HERE, IN THE STATEMENT, not by the caller: `r.owner_id = $2`. Copying a
 * track ATTACHES the original row (eventRoute.service.ts), so a ride very often points at
 * someone else's route — and taking your ride public must never publish a stranger's track on
 * their behalf. A borrowed track simply matches no row and nothing happens.
 *
 * `r.is_public = FALSE` keeps this a no-op when there is nothing to do, so the common PATCH
 * writes no rows and bumps no `updated_at`.
 *
 * Returns how many rows were published — 0 or 1 — for the caller's log line.
 */
export async function publishEventRouteIfOwned(eventId: string, ownerId: number): Promise<number> {
  return execute(
    `UPDATE routes r
        SET is_public = TRUE, updated_at = NOW()
       FROM event_routes er
      WHERE er.event_id = $1
        AND r.id = er.route_id
        AND r.owner_id = $2
        AND r.is_public = FALSE`,
    [eventId, ownerId],
  );
}
