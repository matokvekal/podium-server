import { z } from "zod";

/** Codes are handed out in print and by message; compared case-insensitively. */
export const redeemCouponSchema = z.object({
  code: z.string().min(3).max(64),
});

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  nickname: z.string().min(1).max(100).optional(),
  emergencyPhone: z.string().min(1).max(32).optional(),
  // ISO 3166-1 alpha-2, uppercased on the way in so 'il' and 'IL' cannot both be stored —
  // the same shape as event_participants.country_code. Never cleared: omit to leave it.
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, "country must be two letters")
    .transform((value) => value.toUpperCase())
    .optional(),
});
