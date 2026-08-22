import { z } from "zod";
import { ATTENDANCE_STATUSES, RESULT_STATUSES } from "../../db/types.js";

export const participantsEventIdParamSchema = z.object({
  eventId: z.string().uuid(),
});

export const participantIdParamSchema = z.object({
  eventId: z.string().uuid(),
  participantId: z.coerce.number().int().positive(),
});

export const addParticipantSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(100).optional(),
  category: z.string().max(80).optional(),
  bib: z.string().max(16).optional(),
  team: z.string().max(120).optional(),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, "countryCode must be two letters")
    .transform((value) => value.toUpperCase())
    .optional(),
});

export const updateParticipantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(100).optional(),
  category: z.string().max(80).optional(),
  bib: z.string().max(16).optional(),
  team: z.string().max(120).optional(),
  // ISO 3166-1 alpha-2. Uppercased on the way in so 'il' and 'IL' cannot both end up stored.
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, "countryCode must be two letters")
    .transform((value) => value.toUpperCase())
    .optional(),
});

/**
 * Spreadsheet / phone-contacts import. One request, one transaction — the client was making
 * N sequential POSTs, so a 60-rider list was 60 round trips and a failure halfway left the
 * start list half-imported with no way to tell which half.
 *
 * 500 is well past any realistic ride and keeps the body inside the global 100 kb limit.
 */
export const bulkAddParticipantsSchema = z.object({
  participants: z.array(addParticipantSchema).min(1).max(500),
});

/**
 * The three status axes are written through three separate endpoints, never one merged field
 * — sql/003-participants.sql is emphatic about this: a rider can be approved AND present AND
 * finished at once, and one column cannot say that.
 */
export const setAttendanceSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
});

export const setResultSchema = z.object({
  status: z.enum(RESULT_STATUSES),
  /** Omitted on a "finished" call means "now" — the organizer is tapping as riders arrive. */
  finishedAt: z.coerce.date().optional(),
  finishPosition: z.number().int().positive().optional(),
});
