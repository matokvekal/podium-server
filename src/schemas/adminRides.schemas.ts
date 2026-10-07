import { z } from "zod";

/** The largest value events.max_participants (Postgres INTEGER, sql/060) can hold — a technical
 *  bound only, not a business cap. */
export const PG_INTEGER_MAX = 2_147_483_647;

/** PATCH /api/v1/admin/rides/:eventId — a positive whole number, or null to clear the override. */
export const setRideMaxParticipantsSchema = z.object({
  maxParticipants: z.number().int().min(1).max(PG_INTEGER_MAX).nullable(),
});
