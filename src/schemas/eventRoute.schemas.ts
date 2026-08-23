// Request bodies for THE ROUTE ATTACHED TO AN EVENT — /api/v1/events/:eventId/route
//
// The POST accepts either body below; see eventRoute.controller.ts.

import { z } from "zod";

/** [lat, lng] — same ordering as event.schemas.ts's locationPointSchema. */
const routePointSchema = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);

/**
 * V1 body for POST /events/:eventId/route. The client has already reduced a full GPX/track
 * import (or a hand-drawn line) down to a plain polyline before this ever reaches the server —
 * no splits, markers or preview simplification here, see plan/08-routes-and-maps.md for the
 * fuller route-library schema this deliberately does not use yet.
 *
 * 5000 points is generous for a drawn/copied route while still capping the payload against
 * abuse.
 */
export const setEventRouteSchema = z.object({
  points: z.array(routePointSchema).min(1).max(5000),
  distanceKm: z.number().positive(),
  elevationM: z.number().nullable().optional(),
});

export type SetEventRouteInput = z.infer<typeof setEventRouteSchema>;

/**
 * The other accepted body for POST /events/:eventId/route: attach a route that already exists
 * in the library ("copy the track from another ride") instead of sending geometry.
 */
export const attachRouteSchema = z.object({
  routeId: z.number().int().positive(),
});
