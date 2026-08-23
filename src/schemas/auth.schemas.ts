import { z } from "zod";

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

export const smsRequestSchema = z.object({
  phone: z.string().min(1),
});

export const smsVerifySchema = z.object({
  challengeId: z.number().int().positive(),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
