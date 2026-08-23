// Controllers for THE ROUTE LIBRARY — /api/v1/routes/*
//
// The standalone, reusable routes a ride can be run on. Handlers for the route attached to a
// specific event (/api/v1/events/:eventId/route) are in eventRoute.controller.ts.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import type { RouteWithOwner } from "../queries/routeLibrary.queries.js";
import {
  createRouteSchema,
  publicRoutesQuerySchema,
  routeIdParamSchema,
  updateRouteSchema,
} from "../schemas/routeLibrary.schemas.js";
import {
  createRoute,
  deleteRoute,
  getRouteForViewer,
  listMyRoutes,
  listPublicRoutes,
  updateRoute,
} from "../services/routeLibrary.service.js";

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

// POST /api/v1/routes
export async function createRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createRouteSchema.parse(req.body);
    traceLog("routeLibrary.controller.createRouteController", {
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

// GET /api/v1/routes
export async function listMyRoutesController(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("routeLibrary.controller.listMyRoutesController", { userId: req.auth!.userId });
    const routes = await listMyRoutes(req.auth!.userId);
    res.status(200).json({ data: routes.map(toRouteSummary) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/routes/public
export async function listPublicRoutesController(req: Request, res: Response, next: NextFunction) {
  try {
    const q = publicRoutesQuerySchema.parse(req.query);
    traceLog("routeLibrary.controller.listPublicRoutesController", { page: q.page, pageSize: q.pageSize });
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

// GET /api/v1/routes/:routeId
export async function getRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("routeLibrary.controller.getRouteController", { routeId, viewerId });
    const route = await getRouteForViewer(routeId, viewerId);
    res.status(200).json({ data: toRouteDetail(route) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/routes/:routeId
export async function updateRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    const input = updateRouteSchema.parse(req.body);
    traceLog("routeLibrary.controller.updateRouteController", { routeId, userId: req.auth!.userId });
    const route = await updateRoute(routeId, req.auth!.userId, input);
    res.status(200).json({ data: toRouteSummary({ ...route, ownerName: null }) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/routes/:routeId
export async function deleteRouteController(req: Request, res: Response, next: NextFunction) {
  try {
    const { routeId } = routeIdParamSchema.parse(req.params);
    traceLog("routeLibrary.controller.deleteRouteController", { routeId, userId: req.auth!.userId });
    await deleteRoute(routeId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
