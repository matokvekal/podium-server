// Controllers for THE ROUTE ATTACHED TO AN EVENT.
//
// Every handler for /api/v1/events/:eventId/route is in this file — GET, POST and DELETE.
// They used to be split across two modules, with the POST registered twice (the second
// registration was unreachable). Put a breakpoint in one of these three functions.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  attachRouteSchema,
  copyRouteFromEventSchema,
  eventRouteQuerySchema,
  setEventRouteSchema,
} from "../schemas/eventRoute.schemas.js";
import {
  attachLibraryRouteToEvent,
  copyTrackFromEvent,
  detachRouteFromEvent,
  getEventRouteGeometry,
  getEventRouteWithUsage,
  setEventRouteFromPoints,
} from "../services/eventRoute.service.js";
import { toRouteSummary } from "./routeLibrary.controller.js";

// GET /api/v1/events/:eventId/route
//
// 200 with { data: EventRoute } once a route is set, or { data: null } before one ever is —
// "no route" is a normal state, not a 404. Same { data } envelope every other single-resource
// read in this codebase uses (see toEventDetail, toParticipantSummary).
//
// `?preview=1` adds one field, `usedByRides` — the number of rides built on this track, which
// the track gallery shows as "Downloads". WITHOUT the parameter the body is byte-identical to
// what this endpoint has always returned; that path is a live PWA contract and does not move.
export async function getEventRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { preview } = eventRouteQuerySchema.parse(req.query);
    const viewerId = req.auth?.userId ?? null;
    traceLog("eventRoute.controller.getEventRouteController", { eventId, viewerId, preview });
    const route = preview
      ? await getEventRouteWithUsage(eventId, viewerId)
      : await getEventRouteGeometry(eventId, viewerId);
    res.status(200).json({ data: route });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/route
//
// One endpoint, three request bodies, kept exactly as the clients already send them:
//
//   { sourceEventId }                  -> copy the track from that ride: attaches THAT ride's
//                                         own route row, records the copy, stamps the lineage
//                                         -> 200 { data: RouteSummary }
//   { routeId }                        -> attach an existing library route (Find Tracks)
//                                         -> 200 { data: RouteSummary }
//   { points, distanceKm, elevationM } -> store a drawn/imported line, then attach it
//                                         -> 200 { data: { points, distanceKm, elevationM } }
//
// The first is new; the other two are untouched and answer exactly what they always did. Both
// copy branches return the same RouteSummary shape, so a client does not have to care which of
// the two it used.
export async function setEventRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);

    if (
      req.body &&
      typeof req.body === "object" &&
      // Object.hasOwn, not the hasOwnProperty.call below it: same test, and the form biome
      // wants. The existing branch is left exactly as it was rather than reformatted here.
      Object.hasOwn(req.body, "sourceEventId")
    ) {
      const { sourceEventId } = copyRouteFromEventSchema.parse(req.body);
      traceLog("eventRoute.controller.setEventRouteController", {
        eventId,
        sourceEventId,
        userId: req.auth!.userId,
      });
      const route = await copyTrackFromEvent(eventId, req.auth!.userId, sourceEventId);
      res.status(200).json({ data: toRouteSummary(route) });
      return;
    }

    if (
      req.body &&
      typeof req.body === "object" &&
      Object.prototype.hasOwnProperty.call(req.body, "routeId")
    ) {
      const { routeId } = attachRouteSchema.parse(req.body);
      traceLog("eventRoute.controller.setEventRouteController", {
        eventId,
        routeId,
        userId: req.auth!.userId,
      });
      const route = await attachLibraryRouteToEvent(eventId, req.auth!.userId, routeId);
      res.status(200).json({ data: toRouteSummary(route) });
      return;
    }

    const input = setEventRouteSchema.parse(req.body);
    traceLog("eventRoute.controller.setEventRouteController", {
      eventId,
      userId: req.auth!.userId,
      pointCount: input.points.length,
    });
    const route = await setEventRouteFromPoints(eventId, req.auth!.userId, input);
    res.status(200).json({ data: route });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/route
export async function deleteEventRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("eventRoute.controller.deleteEventRouteController", {
      eventId,
      userId: req.auth!.userId,
    });
    await detachRouteFromEvent(eventId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
