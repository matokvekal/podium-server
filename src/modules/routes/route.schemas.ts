import { z } from "zod";
import { ROUTE_SOURCES, ROUTE_TYPES } from "../../db/types.js";

/**
 * A route is uploaded as already-parsed points. Parsing GPX/TCX/GeoJSON stays on the client
 * (podium-client/src/lib/track-gpx.ts, track-csv.ts) — it already works there, it keeps a
 * malformed 20 MB file off the wire, and it means the "drawn on the map" and "copied from
 * another ride" sources arrive through exactly the same door as a file upload.
 */
export const trackPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Metres. Optional — plenty of sources carry no elevation, and a fabricated 0 would read
   *  as "sea level" rather than "unknown". */
  ele: z.number().nullable().optional(),
});

export const routeMarkerSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().min(1).max(200),
  type: z.enum(["start", "finish", "feed", "point"]).optional(),
});

/**
 * 50 000 points is about a 500 km ride recorded every second — beyond any real route, and
 * comfortably inside the JSONB column. The express body limit (100 kb) is the real
 * constraint for a big upload; see the note in app.ts.
 */
export const createRouteSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  routeType: z.enum(ROUTE_TYPES).optional(),
  source: z.enum(ROUTE_SOURCES).optional().default("drawn"),
  placeName: z.string().max(255).optional(),
  isPublic: z.boolean().optional().default(false),
  points: z.array(trackPointSchema).min(2).max(50_000),
  markers: z.array(routeMarkerSchema).max(500).optional(),
});

/** Rename and publish/unpublish. Geometry is immutable — re-upload to change the line. */
export const updateRouteSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  routeType: z.enum(ROUTE_TYPES).optional(),
  placeName: z.string().max(255).optional(),
  isPublic: z.boolean().optional(),
});

export const routeIdParamSchema = z.object({
  routeId: z.coerce.number().int().positive(),
});

export const attachRouteSchema = z.object({
  routeId: z.number().int().positive(),
});

/** Paging is page/pageSize here, not limit/offset — plan/07-api-contract.md names these. */
export const publicRoutesQuerySchema = z.object({
  place: z.string().max(255).optional(),
  minDistance: z.coerce.number().nonnegative().optional(),
  maxDistance: z.coerce.number().nonnegative().optional(),
  minElevation: z.coerce.number().nonnegative().optional(),
  maxElevation: z.coerce.number().nonnegative().optional(),
  type: z.enum(ROUTE_TYPES).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(60).optional().default(24),
});
