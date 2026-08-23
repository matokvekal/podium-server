// Controllers for THE ROUTE ATTACHED TO AN EVENT.
//
// Every handler for /api/v1/events/:eventId/route is in this file — GET, POST and DELETE.
// They used to be split across two modules, with the POST registered twice (the second
// registration was unreachable). Put a breakpoint in one of these three functions.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import { attachRouteSchema, setEventRouteSchema } from "../schemas/eventRoute.schemas.js";
import {
  attachLibraryRouteToEvent,
  detachRouteFromEvent,
  getEventRouteGeometry,
  setEventRouteFromPoints,
} from "../services/eventRoute.service.js";
import { toRouteSummary } from "./routeLibrary.controller.js";

// GET /api/v1/events/:eventId/route
//
// 200 with { data: EventRoute } once a route is set, or { data: null } before one ever is —
// "no route" is a normal state, not a 404. Same { data } envelope every other single-resource
// read in this codebase uses (see toEventDetail, toParticipantSummary).
export async function getEventRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("eventRoute.controller.getEventRouteController", { eventId, viewerId });
    const route = await getEventRouteGeometry(eventId, viewerId);
    res.status(200).json({ data: route });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/route
//
// One endpoint, two request bodies, two different responses — kept exactly as the clients
// already send them:
//
//   { routeId }                        -> attach an existing library route
//                                         -> 200 { data: RouteSummary }
//   { points, distanceKm, elevationM } -> store a drawn/imported line, then attach it
//                                         -> 200 { data: { points, distanceKm, elevationM } }
export async function setEventRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);

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
