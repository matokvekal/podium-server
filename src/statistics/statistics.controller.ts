import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { leaderboardQuerySchema } from "./statistics.schemas.js";
import { getLeaderboard, getRiderStatsPayload } from "./statistics.service.js";

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
