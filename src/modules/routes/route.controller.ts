import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../../lib/trace-log.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import type { RouteWithOwner } from "./route.queries.js";
import {
  attachRouteSchema,
  createRouteSchema,
  publicRoutesQuerySchema,
  routeIdParamSchema,
  updateRouteSchema,
} from "./route.schemas.js";
import {
  attachRouteToEvent,
  createRoute,
  deleteRoute,
  detachRouteFromEvent,
  getRouteForViewer,
  listMyRoutes,
  listPublicRoutes,
  updateRoute,
} from "./route.service.js";

/**
 * A browse card: everything except the full line. `previewPoints` is what draws the
 * thumbnail — see plan/08-routes-and-maps.md's "many map previews on one screen".
 */
export function toRouteSummary(route: RouteWithOwner) {
  return {
    id: route.id,
    ownerId: route.ownerId,
    ownerName: route.ownerName,
    name: route.name,
    routeType: route.routeType,
    source: route.source,
    placeName: route.placeName,
    isPublic: route.isPublic,
    distanceKm: route.distanceKm,
    elevationM: route.elevationM,
    pointCount: route.pointCount,
    previewPoints: route.previewPoints,
    markers: route.markers,
    startLat: route.startLat,
    startLon: route.startLon,
    endLat: route.endLat,
    endLon: route.endLon,
    bbox:
      route.bboxMinLat === null
        ? null
        : {
            minLat: route.bboxMinLat,
            minLon: route.bboxMinLon,
            maxLat: route.bboxMaxLat,
            maxLon: route.bboxMaxLon,
          },
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

/** The summary plus the real geometry. Only ever returned by GET /routes/:routeId. */
function toRouteDetail(route: RouteWithOwner) {
  return { ...toRouteSummary(route), trackPoints: route.trackPoints };
}

export async function createRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createRouteSchema.parse(req.body);
    traceLog("route.controller.createRouteHandler", {
      userId: req.auth!.userId,
      pointCount: input.points.length,
      source: input.source,
    });
    const route = await createRoute(req.auth!.userId, input);
    // Freshly created, so the caller already has the geometry they just sent — but returning
    // the detail shape keeps "what a route looks like" to one answer.
    res.status(201).json({ data: toRouteDetail({ ...route, ownerName: null }) });
  } catch (err) {
    next(err);
  }
}

export async function listMyRoutesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("route.controller.listMyRoutesHandler", { userId: req.auth!.userId });
    const routes = await listMyRoutes(req.auth!.userId);
    res.status(200).json({ data: routes.map(toRouteSummary) });
  } catch (err) {
    next(err);
  }
}

export async function listPublicRoutesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = publicRoutesQuerySchema.parse(req.query);
    traceLog("route.controller.listPublicRoutesHandler", { page: q.page, pageSize: q.pageSize });
    const { routes, total } = await listPublicRoutes({
      place: q.place,
      minDistance: q.minDistance,
      maxDistance: q.maxDistance,
      minElevation: q.minElevation,
      maxElevation: q.maxElevation,
      type: q.type,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    });
    // `total` is what lets the browser render "‹ 1 2 3 4 ›" — a page of results alone cannot
    // say whether there is a next one.
    res.status(200).json({ data: routes.map(toRouteSummary), total, page: q.page, pageSize: q.pageSize });
  } catch (err) {
    next(err);
  }
}

export async function getRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("route.controller.getRouteHandler", { routeId, viewerId });
    const route = await getRouteForViewer(routeId, viewerId);
    res.status(200).json({ data: toRouteDetail(route) });
  } catch (err) {
    next(err);
  }
}

export async function updateRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    const input = updateRouteSchema.parse(req.body);
    traceLog("route.controller.updateRouteHandler", { routeId, userId: req.auth!.userId });
    const route = await updateRoute(routeId, req.auth!.userId, input);
    res.status(200).json({ data: toRouteSummary({ ...route, ownerName: null }) });
  } catch (err) {
    next(err);
  }
}

export async function deleteRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    traceLog("route.controller.deleteRouteHandler", { routeId, userId: req.auth!.userId });
    await deleteRoute(routeId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---- mounted under the event router ------------------------------------------------------

export async function attachRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { routeId } = attachRouteSchema.parse(req.body);
    traceLog("route.controller.attachRouteHandler", { eventId, routeId, userId: req.auth!.userId });
    const route = await attachRouteToEvent(eventId, req.auth!.userId, routeId);
    res.status(200).json({ data: toRouteSummary(route) });
  } catch (err) {
    next(err);
  }
}

export async function detachRouteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("route.controller.detachRouteHandler", { eventId, userId: req.auth!.userId });
    await detachRouteFromEvent(eventId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
