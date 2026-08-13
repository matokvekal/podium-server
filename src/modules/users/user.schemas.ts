import { z } from "zod";

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  nickname: z.string().min(1).max(100).optional(),
  emergencyPhone: z.string().min(1).max(32).optional(),
});
