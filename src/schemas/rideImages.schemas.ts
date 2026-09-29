import { z } from "zod";
import { RIDE_IMAGE_CATEGORIES } from "../config/ride-image-uploads.js";

/** Query-string fields on POST /api/v1/admin/ride-images — the body is the raw image bytes
 *  (express.raw, app.ts), so there is nowhere else for these two to travel. */
export const uploadRideImageQuerySchema = z.object({
  label: z.string().trim().min(1).max(60),
  category: z.enum(RIDE_IMAGE_CATEGORIES).optional().default("generic"),
});

export const setRideImageSelectableSchema = z.object({
  selectable: z.boolean(),
});

/** `:key` on the admin routes. Deliberately not the RIDE_IMAGE_KEYS enum this once was
 *  (services/rideImages.service.ts now checks existence against the table) — just a safe
 *  charset so a path-traversal or otherwise malformed value 400s before it reaches a query. */
export const rideImageKeyParamSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "not a valid ride-image key");
