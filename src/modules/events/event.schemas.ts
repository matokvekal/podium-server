import { z } from "zod";

export const eventCodeParamSchema = z.object({
  code: z.string().min(1).max(32),
});

export const joinEventSchema = z.object({
  eventCode: z.string().min(1).max(32),
  bib: z.string().min(1).max(16).optional(),
});

export const locationPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  recordedAt: z.coerce.date(),
  emergency: z.boolean().optional().default(false),
});

export const locationBatchSchema = z.object({
  participantId: z.number().int().positive(),
  points: z.array(locationPointSchema).min(1).max(200),
});
