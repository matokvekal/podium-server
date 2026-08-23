// THE ROUTE ATTACHED TO AN EVENT — /api/v1/events/:eventId/route
//
// Business rules for the single route a ride runs on. The route itself is a row in the route
// library (routeLibrary.service.ts); this file only decides which one an event points at, and
// who is allowed to see or change it.
//
// There are two ways to set it, and they are NOT the same operation:
//
//   { routeId }                        -> attachLibraryRouteToEvent  ("copy the track from
//                                         another ride" — links an existing library route)
//   { points, distanceKm, elevationM } -> setEventRouteFromPoints    (stores a hand-drawn or
//                                         imported line, then links it)
//
// Both used to live in different files under different names, one of them reached through a
// shadowed Express route that never ran. They are together here because they answer the same
// request. Their validation deliberately still differs — see the note on
// setEventRouteFromPoints.

import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import {
  attachRouteToEvent,
  deleteEventRoute,
  type EventRoute,
  insertDrawnRouteRow,
  selectEventRouteGeometry,
  selectEventRouteSummary,
} from "../queries/eventRoute.queries.js";
import { selectEventById } from "../queries/event.queries.js";
import type { RouteWithOwner } from "../queries/routeLibrary.queries.js";
import type { SetEventRouteInput } from "../schemas/eventRoute.schemas.js";
import { assertOwner, getEventForViewer } from "./event.service.js";
import { getRouteForViewer } from "./routeLibrary.service.js";

/**
 * Owner-only. Stores the posted geometry as a new library row, then attaches it — replacing
 * whatever route was there. V1 is one active route per event, so re-saving is a full replace,
 * not an accumulation (see attachRouteToEvent).
 *
 * NOTE: unlike attachLibraryRouteToEvent below, this does NOT reject a finished or cancelled
 * event. That asymmetry is pre-existing and is preserved here on purpose — tightening it
 * would change what POST /events/:eventId/route accepts. Flagged in the refactor report.
 */
export async function setEventRouteFromPoints(
  eventId: string,
  userId: number,
  input: SetEventRouteInput,
): Promise<EventRoute> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);

  // routes.is_public and events.visibility are separate flags, and nothing used to bridge
  // them: a route saved for a PUBLIC ride took the column default FALSE, so it never showed
  // up in Find Track (GET /routes/public filters on is_public = TRUE). Publishing the ride
  // is what publishes its track — "registered" and "private" rides keep theirs unlisted.
  const stored = await insertDrawnRouteRow(
    userId,
    input.points,
    input.distanceKm,
    input.elevationM ?? null,
    event.visibility === "public",
  );
  await attachRouteToEvent(eventId, stored.id);
  logger.info({ eventId, userId, routeId: stored.id }, "event route set");
  return { points: stored.points, distanceKm: stored.distanceKm, elevationM: stored.elevationM };
}

/**
 * "Copy the track from another ride" is this call, not a copy: the source ride's routeId is
 * attached to the new event. One line, one row, and a fix to the geometry reaches every ride
 * using it. The route still has to be one the organizer may read — their own, or published.
 */
export async function attachLibraryRouteToEvent(
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
  await attachRouteToEvent(eventId, route.id);
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

/**
 * What GET /api/v1/events/:eventId/route returns: bare geometry, tuple shape.
 *
 * Same visibility rule GET /:eventId already uses (getEventForViewer): 404 if the event
 * doesn't exist, 403 if it's private and the viewer isn't the owner. "No route yet" is a
 * normal state for a visible event, not an error — this returns null, not a 404.
 */
export async function getEventRouteGeometry(
  eventId: string,
  viewerId: number | null,
): Promise<EventRoute | null> {
  await getEventForViewer(eventId, viewerId); // 403s a private event for a stranger
  return selectEventRouteGeometry(eventId);
}

/**
 * The event's route as a browse-card summary, for embedding in the event detail payload.
 *
 * No permission check: every caller (event.controller, results.service) has already resolved
 * the viewer's access to the event itself and decided the route may be shown.
 */
export function getEventRouteSummary(eventId: string): Promise<RouteWithOwner | null> {
  return selectEventRouteSummary(eventId);
}
