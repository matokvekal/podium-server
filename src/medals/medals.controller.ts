import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { traceLog } from "../lib/trace-log.js";
import {
  encodeMedalCursor,
  listMyMedals,
  markMyMedalsSeen,
  MEDALS_PAGE_DEFAULT,
  MEDALS_PAGE_MAX,
} from "../services/eventMedals.service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MEDALS_PAGE_MAX).default(MEDALS_PAGE_DEFAULT),
  before: z.string().min(3).max(100).optional(),
});

const seenBodySchema = z
  .object({ eventIds: z.array(z.string().min(1).max(64)).max(200).optional() })
  .default({});

// GET /api/v1/medals/me?limit=20&before=<cursor>
export async function listMyMedalsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { limit, before } = listQuerySchema.parse(req.query);
    const userId = req.auth!.userId;
    traceLog("medals.controller.listMyMedalsController", { userId, limit, before });
    const page = await listMyMedals(userId, limit, before);
    res.status(200).json({
      data: {
        medals: page.medals.map((medal) => ({
          eventId: medal.eventId,
          eventTitle: medal.eventTitle,
          eventDate: medal.eventDate,
          medalText: medal.medalText,
          medalColorId: medal.medalColorId,
          medalStyleId: medal.medalStyleId,
          awardedAt: medal.awardedAt,
          seen: medal.seenAt !== null,
          cursor: encodeMedalCursor(medal),
        })),
        nextCursor: page.nextCursor,
        // -1 on later pages: the totals are only computed for the first one.
        total: page.total,
        unseen: page.unseen,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/medals/me/seen
export async function markMyMedalsSeenController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventIds } = seenBodySchema.parse(req.body ?? {});
    const userId = req.auth!.userId;
    traceLog("medals.controller.markMyMedalsSeenController", { userId, eventIds });
    const marked = await markMyMedalsSeen(userId, eventIds ?? null);
    res.status(200).json({ data: { marked } });
  } catch (err) {
    next(err);
  }
}
