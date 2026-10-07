import { z } from "zod";

/** POST /events/:eventId/managers — the email the creator typed. Normalised by the service. */
export const addEventManagerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

/** DELETE /events/:eventId/managers/:userId */
export const eventManagerParamSchema = z.object({
  eventId: z.string().uuid(),
  userId: z.coerce.number().int().positive(),
});

/** DELETE /events/:eventId/manager-invites/:email */
export const eventManagerInviteParamSchema = z.object({
  eventId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(320),
});
