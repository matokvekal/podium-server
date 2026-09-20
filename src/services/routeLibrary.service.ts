// THE ROUTE LIBRARY — /api/v1/routes/*
//
// The shared library of lines a ride can be run on. A route is stored independently
// of any event, so one route serves many rides and can be published for anyone to reuse —
// which is what makes "copy the track from another ride" a single attach rather than a copy.
//
// Everything derived (distance, climb, bbox, preview) is computed ONCE here, at creation,
// and never on read. See plan/08-routes-and-maps.md.

import { trackAuditEvent } from "../db/audit/audit.service.js";
import type { Route, RouteMarker, RouteSource, RouteType, TrackPoint } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { computeBbox, simplifyByStride, sumClimbMeters, sumDistanceKm } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { selectEventById } from "../queries/event.queries.js";
// Deleting a library route must first unlink it from any event that uses it — there are no
// foreign keys, so nothing else clears event_routes.
import { deleteEventRoutesForRoute } from "../queries/eventRoute.queries.js";
import {
  deleteRoute as deleteRouteRow,
  insertRoute,
  type PublicRouteFilters,
  type RouteWithOwner,
  selectPublicRoutes,
  selectRouteById,
  selectRoutesForOwner,
  updateRoute as updateRouteRow,
} from "../queries/routeLibrary.queries.js";
import { type RouteGpxFile, selectRouteAccess, selectRouteGpxFile } from "../queries/routeGpx.queries.js";
import {
  deleteRouteFavorite,
  insertRouteFavorite,
  insertRouteLike,
  selectRouteFavoritedByUser,
  selectRouteLikeCount,
} from "../queries/routeLike.queries.js";
import { assertOwner } from "./event.service.js";

/**
 * How many points a preview line keeps. A route card is a thumbnail a few hundred pixels
 * wide — past this, extra points cost bytes and buy no visible detail. Full geometry is
 * always one more request away.
 */
export const PREVIEW_POINT_TARGET = 300;

export async function createRoute(
  ownerId: number,
  input: {
    name?: string;
    routeType?: RouteType;
    source: RouteSource;
    placeName?: string;
    isPublic: boolean;
    points: TrackPoint[];
    markers?: RouteMarker[];
  },
): Promise<Route> {
  const { points } = input;
  const bbox = computeBbox(points);
  const first = points[0];
  const last = points[points.length - 1];

  const route = await insertRoute({
    ownerId,
    name: input.name ?? null,
    routeType: input.routeType ?? null,
    source: input.source,
    placeName: input.placeName ?? null,
    isPublic: input.isPublic,
    distanceKm: sumDistanceKm(points),
    // Null, not 0, when no point carried elevation — "unknown" and "flat" are different
    // answers, and a filter for "under 200 m of climb" must not quietly include the unknowns.
    elevationM: sumClimbMeters(points.map((p) => p.ele)),
    trackPoints: points,
    markers: input.markers ?? null,
    previewPoints: simplifyByStride(points, PREVIEW_POINT_TARGET),
    pointCount: points.length,
    startLat: first.lat,
    startLon: first.lng,
    endLat: last.lat,
    endLon: last.lng,
    bboxMinLat: bbox?.minLat ?? null,
    bboxMinLon: bbox?.minLon ?? null,
    bboxMaxLat: bbox?.maxLat ?? null,
    bboxMaxLon: bbox?.maxLon ?? null,
  });

  logger.info(
    { routeId: route.id, ownerId, pointCount: points.length, source: input.source },
    "route created",
  );
  // Analytics — a new library route (POST /routes). `input.source` is the real routes.source
  // value the client sent (ROUTE_SOURCES: gpx | tcx | geojson | json | drawn | copied).
  // Non-fatal. No rideId — a library route is not attached to a ride at this point.
  void trackAuditEvent({
    type: "ROUTE_CREATED",
    userId: ownerId,
    routeId: route.id,
    details: { source: input.source },
  });
  return route;
}

/**
 * A route is readable by its owner, and by anyone once published. Same 404-not-403 rule as a
 * private event: an unpublished route's id says nothing about whether it exists.
 */
export async function getRouteForViewer(
  routeId: number,
  viewerId: number | null,
): Promise<RouteWithOwner> {
  const route = await selectRouteById(routeId);
  if (!route) throw new ApiError(404, "Route not found");
  if (!route.isPublic && route.ownerId !== viewerId) throw new ApiError(404, "Route not found");
  return route;
}

/**
 * The ORIGINAL GPX of a route, byte for byte (sql/042), or null when it has none — the caller then
 * answers 404 and the client falls back to the file it rebuilds from the stored line. Same
 * visibility as the route itself, with the same 404-not-403 rule: an unpublished route's id says
 * nothing about whether it exists.
 */
export async function getRouteGpxForViewer(
  routeId: number,
  viewerId: number | null,
): Promise<RouteGpxFile | null> {
  const access = await selectRouteAccess(routeId);
  if (!access) throw new ApiError(404, "Route not found");
  if (!access.isPublic && access.ownerId !== viewerId) throw new ApiError(404, "Route not found");
  return selectRouteGpxFile(routeId);
}

export function listMyRoutes(ownerId: number): Promise<RouteWithOwner[]> {
  return selectRoutesForOwner(ownerId);
}

export function listPublicRoutes(
  filters: PublicRouteFilters,
): Promise<{ routes: RouteWithOwner[]; total: number }> {
  return selectPublicRoutes(filters);
}

async function assertRouteOwner(routeId: number, userId: number): Promise<Route> {
  const route = await selectRouteById(routeId);
  if (!route) throw new ApiError(404, "Route not found");
  if (route.ownerId !== userId) throw new ApiError(403, "Only the route owner may do this");
  return route;
}

export async function updateRoute(
  routeId: number,
  userId: number,
  input: { name?: string; routeType?: RouteType; placeName?: string; isPublic?: boolean },
): Promise<Route> {
  await assertRouteOwner(routeId, userId);
  const updated = await updateRouteRow(routeId, input);
  if (!updated) throw new Error(`updateRoute: route ${routeId} not found after update`);
  logger.info({ routeId, userId, isPublic: updated.isPublic }, "route updated");
  return updated;
}

/**
 * There are no foreign keys in this schema (sql/README.md), so nothing cleans up after a
 * deleted route on its own — the event_routes rows have to go first, or every ride pointing
 * at this route keeps a link to a row that no longer exists and silently renders no map.
 *
 * Note what that means for the organizer of an affected ride: their track disappears, and
 * they were not the one who deleted it. Unpublishing (`PATCH { isPublic: false }`) is the
 * reversible option and is what the UI should offer for "I don't want this shared any more";
 * delete is for a route nobody is using.
 */
export async function deleteRoute(routeId: number, userId: number): Promise<void> {
  await assertRouteOwner(routeId, userId);
  await deleteEventRoutesForRoute(routeId);
  await deleteRouteRow(routeId);
  logger.info({ routeId, userId }, "route deleted");
}

/**
 * LIKES AND FAVOURITES ARE ON THE TRACK, NOT THE RIDE. One `routes` row is shared by every ride
 * built on it (copying attaches the row rather than forking the geometry — see the box in
 * eventRoute.service.ts), so a like counted here is the same number on every card that shows
 * this track. That is the point: a rider rating a line is rating the line.
 *
 * Both go through getRouteForViewer first, so a rider can only like or bookmark a track they
 * could actually open. It 404s rather than 403s an unpublished route, and that rule is not
 * re-implemented here — reusing it is what keeps the two surfaces honest with each other.
 */

/**
 * Liking is ONCE AND PERMANENT, and idempotent by design. Pressing the button again is not an
 * error and does not unlike: the answer to "have I liked this" is true either way, so a retry
 * on a bad connection — which is the normal case on a card in an infinite list — is safe.
 *
 * There is no unlike. The count is append-only for the same reason the reuse count is
 * (sql/036, sql/025): it must never go down.
 */
export async function likeRoute(
  routeId: number,
  userId: number,
): Promise<{ likes: number; likedByMe: true }> {
  await getRouteForViewer(routeId, userId);
  const inserted = await insertRouteLike(routeId, userId);
  const likes = await selectRouteLikeCount(routeId);
  if (inserted) {
    logger.info({ routeId, userId, likes }, "route liked");
    // Analytics only, and only for a like that actually counted. trackAuditEvent swallows its
    // own errors, so a failure here can never cost the rider their like.
    void trackAuditEvent({ type: "ROUTE_LIKED", userId, routeId, details: {} });
  }
  return { likes, likedByMe: true };
}

/**
 * The rider's own bookmark. Unlike a like this really does toggle — nobody counts it, it is
 * private to them, and "remove from my list" has to actually remove.
 *
 * Also idempotent: favouriting twice, or unfavouriting something that was never there, returns
 * the state the caller asked for rather than failing.
 */
export async function setRouteFavorite(
  routeId: number,
  userId: number,
  on: boolean,
): Promise<{ favoritedByMe: boolean }> {
  await getRouteForViewer(routeId, userId);
  if (on) {
    await insertRouteFavorite(routeId, userId);
  } else {
    await deleteRouteFavorite(routeId, userId);
  }
  return { favoritedByMe: await selectRouteFavoritedByUser(routeId, userId) };
}
