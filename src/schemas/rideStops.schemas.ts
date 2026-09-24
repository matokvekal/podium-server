import { z } from "zod";
import { RIDE_STOP_KINDS } from "../config/ride-stops.js";

/** /events/:eventId/stops/:stopId */
export const rideStopParamSchema = z.object({
  eventId: z.string().uuid(),
  stopId: z.coerce.number().int().positive(),
});

const lat = z.number().finite().min(-90).max(90);
const lng = z.number().finite().min(-180).max(180);
// Loose cap only — the real length rule is the service's, on the trimmed text.
const label = z.string().max(1000);

/**
 * POST /events/:eventId/stops — what the creator chose. Who created it and when are the
 * server's; anything else a client sends is stripped by zod.
 */
export const rideStopCreateSchema = z.object({
  label,
  lat,
  lng,
  kind: z.enum(RIDE_STOP_KINDS).optional(),
});

/** PATCH /events/:eventId/stops/:stopId — any subset; a drag sends only lat + lng. */
export const rideStopUpdateSchema = z
  .object({
    label: label.optional(),
    lat: lat.optional(),
    lng: lng.optional(),
    kind: z.enum(RIDE_STOP_KINDS).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "lat and lng move together",
  });
