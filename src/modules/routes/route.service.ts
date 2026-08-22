// Routes: the shared library of lines a ride can be run on. A route is stored independently
// of any event, so one route serves many rides and can be published for anyone to reuse —
// which is what makes "copy the track from another ride" a single attach rather than a copy.
//
// Everything derived (distance, climb, bbox, preview) is computed ONCE here, at creation,
// and never on read. See plan/08-routes-and-maps.md.

import type { Route, RouteMarker, RouteSource, RouteType, TrackPoint } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { computeBbox, simplifyByStride, sumClimbMeters, sumDistanceKm } from "../../lib/geo.js";
import { logger } from "../../lib/logger.js";
import { selectEventById } from "../events/event.queries.js";
import { assertOwner } from "../events/event.service.js";
import {
  deleteEventRoute,
  deleteEventRoutesForRoute,
  deleteRoute as deleteRouteRow,
  insertRoute,
  type PublicRouteFilters,
  type RouteWithOwner,
  replaceEventRoute,
  selectPublicRoutes,
  selectRouteById,
  selectRouteForEvent,
  selectRoutesForOwner,
  updateRoute as updateRouteRow,
} from "./route.queries.js";

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

// ---- attaching to an event ---------------------------------------------------------------

/**
 * "Copy the track from another ride" is this call, not a copy: the source ride's routeId is
 * attached to the new event. One line, one row, and a fix to the geometry reaches every ride
 * using it. The route still has to be one the organizer may read — their own, or published.
 */
export async function attachRouteToEvent(
  eventId: string,
  userId: number,
  routeId: number,
): Promise<RouteWithOwner> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  if (event.status === "finished" || event.status === "cancelled") {
    throw new ApiError(400, `Cannot change the route of a ${event.status} event`);
  }

  const route = await getRouteForViewer(routeId, userId);
  await replaceEventRoute(eventId, route.id);
  logger.info({ eventId, routeId, userId }, "route attached to event");
  return route;
}

export async function detachRouteFromEvent(eventId: string, userId: number): Promise<void> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  const removed = await deleteEventRoute(eventId);
  if (!removed) throw new ApiError(404, "This event has no route attached");
  logger.info({ eventId, userId }, "route detached from event");
}

export function getEventRoute(eventId: string): Promise<RouteWithOwner | null> {
  return selectRouteForEvent(eventId);
}
