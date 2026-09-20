import { z } from "zod";

/**
 * GET /statistics/periods — the month or year timeline. `from` is optional: a client that already
 * holds the settled history sends the oldest period it is unsure of ('2026-08' for months, '2026'
 * for years) so only the tail is computed and returned. Its shape is checked against `type` here
 * because a zod refine keeps a malformed value a 400 instead of a silently ignored parameter.
 */
export const periodsQuerySchema = z
  .object({
    type: z.enum(["month", "year"]),
    from: z.string().optional(),
  })
  .refine(
    (q) =>
      q.from === undefined ||
      (q.type === "month" ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}$/).test(q.from),
    { message: "from must be YYYY-MM for type=month or YYYY for type=year", path: ["from"] },
  );

/** rides | distanceKm | climbM | hours — no calories (National Leaderboard only). */
export const leaderboardQuerySchema = z.object({
  category: z.enum(["rides", "distanceKm", "climbM", "hours"]),
  period: z.enum(["lifetime", "year"]).optional().default("lifetime"),
  // Only meaningful when period="year"; defaults to the current calendar year in the service.
  year: z.coerce.number().int().min(2000).max(9999).optional(),
  // Two-letter country code. Optional — defaults to the caller's own users.country. Uppercased
  // the same way updateProfileSchema's country field is, so 'il' and 'IL' cannot diverge.
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, "country must be two letters")
    .transform((value) => value.toUpperCase())
    .optional(),
});
