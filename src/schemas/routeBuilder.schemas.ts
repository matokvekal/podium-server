import { z } from "zod";
import { ROUTING_PROFILES } from "../lib/routing/provider.js";

const point = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

export const segmentRequestSchema = z.object({
  from: point,
  to: point,
  profile: z.enum(ROUTING_PROFILES),
});

export type SegmentRequest = z.infer<typeof segmentRequestSchema>;
