import { z } from "zod";

/** Highest per-ride rider cap the admin can set — well above any real ride, low enough that a
 *  typo with three extra zeros is refused rather than saved. */
export const ADMIN_RIDE_MAX_PARTICIPANTS = 100_000;

/** PATCH /api/v1/admin/rides/:eventId — a positive whole number, or null to clear the override. */
export const setRideMaxParticipantsSchema = z.object({
  maxParticipants: z.number().int().min(1).max(ADMIN_RIDE_MAX_PARTICIPANTS).nullable(),
});
