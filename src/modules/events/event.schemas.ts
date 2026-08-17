import { z } from "zod";
import { DISPLAY_MODES, EVENT_STATUSES, EVENT_TYPES, EVENT_VISIBILITIES } from "../../db/types.js";

export const eventCodeParamSchema = z.object({
  code: z.string().min(1).max(32),
});

export const eventIdParamSchema = z.object({
  eventId: z.string().uuid(),
});

export const createEventSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(EVENT_TYPES).optional().default("RIDE"),
  requiresBib: z.boolean().optional().default(false),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  displayMode: z.enum(DISPLAY_MODES).optional().default("standard"),
  visibility: z.enum(EVENT_VISIBILITIES).optional().default("private"),
  description: z.string().max(4000).optional(),
  location: z.string().max(255).optional(),
  requiresApproval: z.boolean().optional().default(false),
});

export const updateEventSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  requiresBib: z.boolean().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  displayMode: z.enum(DISPLAY_MODES).optional(),
  visibility: z.enum(EVENT_VISIBILITIES).optional(),
  description: z.string().max(4000).optional(),
  location: z.string().max(255).optional(),
  showEventInfo: z.boolean().optional(),
  showParticipants: z.boolean().optional(),
  showRoute: z.boolean().optional(),
  showLiveLocations: z.boolean().optional(),
  showHistoryLocations: z.boolean().optional(),
  showResults: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
});

export const changeEventStatusSchema = z.object({
  status: z.enum(EVENT_STATUSES),
});

export const pauseEventSchema = z.object({
  paused: z.boolean(),
});

/** ?riders=1,2,3 on GET /:eventId/live — invalid/non-positive ids are dropped rather than 400ing. */
export const liveQuerySchema = z.object({
  riders: z
    .string()
    .optional()
    .transform((value): number[] | null => {
      if (!value) return null;
      return value
        .split(",")
        .map((part) => Number(part))
        .filter((n) => Number.isInteger(n) && n > 0);
    }),
});

export const listEventsQuerySchema = z.object({
  filter: z.enum(["mine", "joined", "upcoming", "live", "past"]).optional().default("mine"),
});

export const publicEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
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
