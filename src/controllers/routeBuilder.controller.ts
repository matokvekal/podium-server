// Controllers for THE ROUTE BUILDER — /api/v1/route-builder/*
//
// A thin proxy to the routing provider (lib/routing/). The client never talks to BRouter
// directly: the server keeps the provider swappable, caches answers, and rate-limits per rider
// so one busy editor cannot exhaust a shared routing service.

import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/api-error.js";
import { haversineDistanceKm } from "../lib/geo.js";
import { ROUTING_UNAVAILABLE_MESSAGE } from "../lib/routing/brouter.js";
import { getRoutingProvider } from "../lib/routing/index.js";
import { traceLog } from "../lib/trace-log.js";
import { segmentRequestSchema } from "../schemas/routeBuilder.schemas.js";

/** A segment is waypoint-to-waypoint. A rider adds points far closer than this; a request this
 *  long is a mis-tap across the map, and would be the slowest thing BRouter could be asked. */
export const MAX_SEGMENT_STRAIGHT_KM = 150;

// GET /api/v1/route-builder/config
export function getRouteBuilderConfigController(_req: Request, res: Response) {
  traceLog("routeBuilder.config", {});
  res.json({ data: { routingEnabled: getRoutingProvider() !== null } });
}

// POST /api/v1/route-builder/segment
export async function routeSegmentController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = segmentRequestSchema.parse(req.body);
    traceLog("routeBuilder.segment", { profile: body.profile, userId: req.auth?.userId });

    const provider = getRoutingProvider();
    if (!provider) throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);
    if (haversineDistanceKm(body.from, body.to) > MAX_SEGMENT_STRAIGHT_KM) {
      throw new ApiError(
        400,
        `Points are too far apart to route in one step (over ${MAX_SEGMENT_STRAIGHT_KM} km). Add a point in between.`,
      );
    }

    const segment = await provider.calculateSegment(body.from, body.to, body.profile);
    res.json({ data: segment });
  } catch (err) {
    next(err);
  }
}
