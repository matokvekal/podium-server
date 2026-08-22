import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../../lib/trace-log.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import { setEventRouteSchema } from "./routes.schemas.js";
import { getEventRoute, setEventRoute } from "./routes.service.js";

export async function setRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = setEventRouteSchema.parse(req.body);
    traceLog("routes.controller.setRouteHandler", {
      eventId,
      userId: req.auth!.userId,
      pointCount: input.points.length,
    });
    const route = await setEventRoute(eventId, req.auth!.userId, input);
    res.status(200).json({ data: route });
  } catch (err) {
    next(err);
  }
}

/** 200 with { data: EventRoute } once a route is set, or { data: null } before one ever is —
 * "no route" is a normal state, not a 404. Same { data } envelope every other single-resource
 * read in this codebase uses (see toEventDetail, toParticipantSummary). */
export async function getRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("routes.controller.getRouteHandler", { eventId, viewerId });
    const route = await getEventRoute(eventId, viewerId);
    res.status(200).json({ data: route });
  } catch (err) {
    next(err);
  }
}
