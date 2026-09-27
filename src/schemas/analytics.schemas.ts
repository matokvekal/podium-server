import { z } from "zod";

/**
 * POST /api/v1/analytics/page-view — what the client sends on a real SPA route change.
 * event_time, user_id (from auth), isBot and deviceType are all derived server-side; nothing
 * here is trusted beyond its shape.
 */
export const pageViewSchema = z.object({
  path: z.string().min(1).max(300),
  visitorId: z.string().uuid(),
  sessionId: z.string().uuid(),
  referrer: z.string().max(500).nullable().optional(),
});

export type PageViewInput = z.infer<typeof pageViewSchema>;
