import { z } from "zod";

/** GET /events/:eventId/chat?afterId=N — only messages newer than N (the polling read). */
export const rideChatListQuerySchema = z.object({
  afterId: z.coerce.number().int().nonnegative().optional(),
});

/**
 * POST /events/:eventId/chat — the text ONLY. Anything else a client sends (a name, a user id,
 * a time) is stripped by zod and never reaches the service. The length / emptiness rules are
 * the service's, on the trimmed text; this cap only refuses an absurd payload early.
 */
export const rideChatSendSchema = z.object({
  text: z.string().max(10_000),
});

/**
 * GET /events/chat/unread?rides=<rideId>:<lastReadId>,... — one request for a whole ride list.
 * A malformed pair is dropped rather than failing the list, like csvEnum elsewhere.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rideChatUnreadQuerySchema = z.object({
  rides: z
    .string()
    .max(10_000)
    .optional()
    .transform((value) => {
      const pairs: { rideId: string; lastReadId: number }[] = [];
      const seen = new Set<string>();
      for (const part of (value ?? "").split(",")) {
        const [rideId, last] = part.split(":");
        if (!rideId || !UUID.test(rideId) || seen.has(rideId)) continue;
        const lastReadId = last ? Number(last) : 0;
        if (!Number.isSafeInteger(lastReadId) || lastReadId < 0) continue;
        seen.add(rideId);
        pairs.push({ rideId, lastReadId });
      }
      return pairs;
    }),
});
