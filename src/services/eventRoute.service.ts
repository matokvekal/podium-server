// THE ROUTE ATTACHED TO AN EVENT — /api/v1/events/:eventId/route
//
// Business rules for the single route a ride runs on. The route itself is a row in the route
// library (routeLibrary.service.ts); this file only decides which one an event points at, and
// who is allowed to see or change it.
//
// There are three ways to set it, and they are NOT the same operation:
//
//   { sourceEventId }                  -> copyTrackFromEvent         ("copy the track from THAT
//                                         ride" — links that ride's own route row)
//   { routeId }                        -> attachLibraryRouteToEvent  (links a library route, the
//                                         Find Tracks path)
//   { points, distanceKm, elevationM } -> setEventRouteFromPoints    (stores a hand-drawn or
//                                         imported line, then links it)
//
// The first two both LINK an existing row and both count as a copy against that track
// (recordRouteCopy, sql/025). Only the third writes new geometry, and it is not a copy of
// anything. Until copyTrackFromEvent existed, "copy from another ride" went through the THIRD
// one — the client re-POSTed the geometry it had just fetched — which forked a second routes
// row and left the original with no idea it had been used.
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
  selectEventRouteId,
  selectEventRouteSummary,
} from "../queries/eventRoute.queries.js";
import { selectEventById, updateEventCopiedFrom } from "../queries/event.queries.js";
import { insertRouteCopy, selectRouteCopyCount } from "../queries/routeCopy.queries.js";
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
 * Records that a ride was built on someone's track, and stamps the new ride with where its
 * track came from — sql/025-track-copy-lineage.sql.
 *
 * NON-FATAL BY CONSTRUCTION. The attach has already committed by the time this runs, and a
 * rider must never lose a saved ride because a counter could not be written. Everything in here
 * is wrapped: a database without sql/025 applied, a lost race, a dropped connection — all warn
 * and return. The worst outcome is a track that attached correctly and a number that did not
 * move, which is the state the whole product was in before this feature existed.
 *
 * `sourceEventId` is null when the track came from Find Tracks: no source ride exists there.
 *
 * Copying your OWN track is not a copy and does not count. That is a product rule, not an
 * integrity one, so it lives here rather than in the schema. Double-counting is the schema's
 * job — route_copies_route_event_key makes a re-save a no-op no matter what this function does.
 */
async function recordRouteCopy(
  routeId: number,
  route: RouteWithOwner,
  userId: number,
  newEventId: string,
  sourceEventId: string | null,
): Promise<void> {
  try {
    if (route.ownerId === userId) {
      logger.debug({ routeId, userId }, "route copy not counted — the rider owns this track");
    } else {
      const counted = await insertRouteCopy({
        routeId,
        copiedByUserId: userId,
        newEventId,
        sourceEventId,
      });
      logger.info({ routeId, userId, newEventId, sourceEventId, counted }, "track copy recorded");
    }
  } catch (err) {
    logger.warn(
      { err, routeId, newEventId },
      "could not record the track copy — the track is attached; run sql/025-track-copy-lineage.sql",
    );
  }

  // Guarded internally against a database without sql/025, and deliberately outside the catch
  // above so a failed ledger write does not also skip the lineage stamp.
  try {
    await updateEventCopiedFrom(newEventId, sourceEventId, routeId);
  } catch (err) {
    logger.warn({ err, newEventId }, "could not stamp the ride's track lineage");
  }
}

/**
 * Attach a track that already exists in the library — the Find Tracks path, POST { routeId }.
 * One line, one row, and a fix to the geometry reaches every ride using it. The route still has
 * to be one the organizer may read — their own, or published.
 *
 * Counts as a copy (see recordRouteCopy) with no source ride: the rider picked the bare track
 * out of the library, so there is no ride to point at, and copied_from_event_id stays null.
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
  await recordRouteCopy(route.id, route, userId, eventId, null);
  return route;
}

/**
 * "Copy the track from THAT ride" — POST { sourceEventId }.
 *
 * This is an attach, not a copy: the source ride's own track row is linked to the new ride. One
 * row of geometry, shared, so a fix to the original reaches every ride built on it — the rule
 * ELNINO_AGENT_SOURCE_OF_TRUTH_SHORT.md has stated all along. Until this existed the client did
 * the copy itself, by re-POSTing the geometry it had just fetched, which FORKED a second routes
 * row: the two rides then shared nothing, and the original had no way to know it had been used.
 *
 * PERMISSION FOLLOWS THE RIDE, NOT THE TRACK, and that is deliberate. The check is
 * getEventForViewer on the source ride — if you can see the ride, you can copy its track. That
 * is exactly what the picker could already do (it reads GET /events/:id/route, gated the same
 * way), so this endpoint grants nothing that was not already reachable. The stricter
 * own-or-public check on the track itself stays where it was, on the { routeId } path above,
 * which reaches the public library rather than a specific ride.
 */
export async function copyTrackFromEvent(
  eventId: string,
  userId: number,
  sourceEventId: string,
): Promise<RouteWithOwner> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  if (event.status === "finished" || event.status === "cancelled") {
    throw new ApiError(400, `Cannot change the route of a ${event.status} event`);
  }
  if (sourceEventId === eventId) {
    throw new ApiError(400, "A ride cannot copy its track from itself");
  }

  // 404s a missing source ride and 403s a private one the copier may not see. This is the ONLY
  // permission gate on the copy, by design — see the note above.
  await getEventForViewer(sourceEventId, userId);

  // Deliberately NOT getRouteForViewer: that asks "is this track yours or published", which is
  // the wrong question here and would reject a perfectly visible ride whose track happens to be
  // unlisted (routes.is_public only goes true for a PUBLIC ride — setEventRouteFromPoints). The
  // source ride's own visibility already settled access, and this read is the same one the
  // event detail payload makes for any viewer who can see the ride.
  const route = await selectEventRouteSummary(sourceEventId);
  if (!route) throw new ApiError(404, "That ride has no track to copy");
  const routeId = route.id;

  await attachRouteToEvent(eventId, routeId);
  logger.info({ eventId, sourceEventId, routeId, userId }, "track copied from another ride");
  await recordRouteCopy(routeId, route, userId, eventId, sourceEventId);
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
 * The same geometry, plus `usedByRides` — how many rides have been built on this track. Served
 * only for GET /events/:eventId/route?preview=1, which is what the track gallery asks for and
 * renders as its "Downloads" stat (client: useTrackGallery.ts, TrackGalleryCard.tsx).
 *
 * A SEPARATE FUNCTION rather than an optional flag on getEventRouteGeometry, so the plain read
 * above — a live PWA contract — keeps returning byte-identical bodies and cannot be changed by
 * accident from here.
 *
 * The count is deliberately non-fatal: if sql/025 has not been applied the ledger table does not
 * exist, and a map that draws with no number beside it is a far better answer than a route
 * request that 500s. The client already treats the field as optional and drops the stat when it
 * is absent, so omitting it degrades exactly the way it was built to.
 */
export async function getEventRouteWithUsage(
  eventId: string,
  viewerId: number | null,
): Promise<(EventRoute & { usedByRides?: number }) | null> {
  await getEventForViewer(eventId, viewerId);
  const route = await selectEventRouteGeometry(eventId);
  if (!route) return null;

  try {
    const routeId = await selectEventRouteId(eventId);
    if (routeId === null) return route;
    return { ...route, usedByRides: await selectRouteCopyCount(routeId) };
  } catch (err) {
    logger.warn({ err, eventId }, "could not read the track copy count — returning route only");
    return route;
  }
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
