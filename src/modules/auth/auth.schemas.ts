import { z } from "zod";
import { ROLES } from "../../db/types.js";

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

/**
 * ⚠ TEMPORARY DEVELOPMENT AID — DELETE BEFORE PRODUCTION. See README.md > Developer sign-in.
 *
 * `key` distinguishes fake users, so a developer can hold two sessions (say a commissaire
 * in one browser and a rider in another) without them sharing one account. Restricted to a
 * short slug because it becomes part of the identity's provider_user_id.
 */
export const devLoginSchema = z.object({
  role: z.enum(ROLES).default("COMMISSAIRE"),
  key: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/i, "key must be 1-32 letters, digits or hyphens")
    .default("default"),
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
