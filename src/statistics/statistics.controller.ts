import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { leaderboardQuerySchema, periodsQuerySchema } from "./statistics.schemas.js";
import { getLeaderboard, getPeriodTimeline, getRiderStatsPayload } from "./statistics.service.js";

// GET /api/v1/statistics/periods?type=month&from=2026-08
export async function getPeriodTimelineController(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, from } = periodsQuerySchema.parse(req.query);
    traceLog("statistics.controller.getPeriodTimelineController", {
      userId: req.auth!.userId,
      type,
      from,
    });
    res.status(200).json({ data: await getPeriodTimeline(req.auth!.userId, type, from) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/statistics/me
export async function getMyStatisticsController(req: Request, res: Response, next: NextFunction) {
  traceLog("statistics.controller.getMyStatisticsController", { userId: req.auth!.userId });
  try {
    res.status(200).json({ data: await getRiderStatsPayload(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/statistics/leaderboard?category=distanceKm&period=year&year=2026&country=IL
export async function getLeaderboardController(req: Request, res: Response, next: NextFunction) {
  try {
    const { category, period, year, country } = leaderboardQuerySchema.parse(req.query);
    traceLog("statistics.controller.getLeaderboardController", {
      userId: req.auth!.userId,
      category,
      period,
      year,
      country,
    });
    res
      .status(200)
      .json({ data: await getLeaderboard(req.auth!.userId, category, period, year, country) });
  } catch (err) {
    next(err);
  }
}
