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
 * The stored preview line is held in the same two shapes as track_points — [lat, lng] tuples
 * and {lat, lng, ele} objects (see the box atop eventRoute.queries.ts). The card contract is
 * tuples, so the elevation is split off into a parallel array rather than handed over inline,
 * which would have made the thumbnail undrawable for the client.
 *
 * Built in one pass so a dropped point leaves both arrays, at the same index.
 */
function splitPreview(points: unknown): {
  previewPoints: [number, number][] | null;
  previewElevations: (number | null)[] | null;
} {
  if (!Array.isArray(points)) return { previewPoints: null, previewElevations: null };

  const line: [number, number][] = [];
  const elevations: (number | null)[] = [];
  let hasElevation = false;

  for (const point of points) {
    if (Array.isArray(point)) {
      const [lat, lng] = point as [unknown, unknown];
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      line.push([lat, lng]);
      elevations.push(null);
      continue;
    }
    if (typeof point !== "object" || point === null) continue;

    const { lat, lng, ele } = point as { lat?: unknown; lng?: unknown; ele?: unknown };
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    line.push([lat, lng]);

    const usable = typeof ele === "number" && Number.isFinite(ele);
    if (usable) hasElevation = true;
    elevations.push(usable ? (ele as number) : null);
  }

  return {
    previewPoints: line.length > 0 ? line : null,
    previewElevations: hasElevation ? elevations : null,
  };
}

/**
 * A browse card: everything except the full line. `previewPoints` is what draws the
 * thumbnail — see plan/08-routes-and-maps.md's "many map previews on one screen".
 */
export function toRouteSummary(route: RouteWithOwner) {
  const preview = splitPreview(route.previewPoints);
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
    previewPoints: preview.previewPoints,
    // Additive: absent for every route stored without elevation, so an older card is unchanged.
    ...(preview.previewElevations ? { previewElevations: preview.previewElevations } : {}),
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
