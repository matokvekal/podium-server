import { z } from "zod";

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
