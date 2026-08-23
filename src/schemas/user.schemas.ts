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
});
