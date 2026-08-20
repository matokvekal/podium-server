import { z } from "zod";

export const groupIdParamSchema = z.object({
  eventId: z.string().uuid(),
  groupId: z.coerce.number().int().positive(),
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(120),
  /** Omitted means "starts with the event". */
  startsAt: z.coerce.date().optional(),
  routeId: z.number().int().positive().optional(),
});

/**
 * `startsAt` and `routeId` are `.nullable()`, not merely optional: null is a real instruction
 * here — "this group starts with everyone else" and "this group uses the event's track" —
 * and has to be distinguishable from "I did not mention this field".
 */
export const updateGroupSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  routeId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

/** Bulk by design — filling a 20-person group one rider at a time is the actual complaint. */
export const assignRidersSchema = z.object({
  participantIds: z.array(z.number().int().positive()).min(1).max(500),
  /** null takes them out of every group without removing them from the event. */
  groupId: z.number().int().positive().nullable(),
});
