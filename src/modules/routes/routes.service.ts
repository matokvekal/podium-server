// Setting/reading the one route attached to an event. Fixes the bug where a creator's chosen
// route lived only in client-side localStorage — every other viewer saw a fabricated,
// deterministic-by-event-id mock route instead of the real one. See plan/08-routes-and-maps.md.

import { ApiError } from "../../lib/api-error.js";
import { logger } from "../../lib/logger.js";
import { selectEventById } from "../events/event.queries.js";
import { assertOwner, getEventForViewer } from "../events/event.service.js";
import {
  attachRouteToEvent,
  type EventRoute,
  insertRoute,
  selectRouteForEvent,
} from "./routes.queries.js";
import type { SetEventRouteInput } from "./routes.schemas.js";

/**
 * Owner-only. Replaces whatever route (if any) is currently attached to the event — V1 is one
 * active route per event, so re-saving is a full replace, not an accumulation (see
 * attachRouteToEvent).
 */
export async function setEventRoute(
  eventId: string,
  userId: number,
  input: SetEventRouteInput,
): Promise<EventRoute> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);

  const stored = await insertRoute(
    userId,
    input.points,
    input.distanceKm,
    input.elevationM ?? null,
  );
  await attachRouteToEvent(eventId, stored.id);
  logger.info({ eventId, userId, routeId: stored.id }, "event route set");
  return { points: stored.points, distanceKm: stored.distanceKm, elevationM: stored.elevationM };
}

/**
 * Same visibility rule GET /:eventId already uses (getEventForViewer): 404 if the event
 * doesn't exist, 403 if it's private and the viewer isn't the owner. "No route yet" is a
 * normal state for a visible event, not an error — this returns null, not a 404.
 */
export async function getEventRoute(
  eventId: string,
  viewerId: number | null,
): Promise<EventRoute | null> {
  await getEventForViewer(eventId, viewerId); // 403s a private event for a stranger
  return selectRouteForEvent(eventId);
}
