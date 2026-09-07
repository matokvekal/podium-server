import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { getAdminAnalytics } from "./adminAnalytics.service.js";
import type { AnalyticsRange } from "./adminAnalytics.types.js";

/** ?range=7|30|90|all — anything else falls back to 30. */
function parseRange(raw: unknown): AnalyticsRange {
  if (raw === "all") return null;
  const n = Number(raw);
  if (n === 7 || n === 90) return n;
  return 30;
}

// GET /api/v1/admin/analytics   (behind requireAuth + requireAdminAnalytics)
export async function getAdminAnalyticsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  traceLog("adminAnalytics.controller.get", { userId: req.auth!.userId });
  try {
    const data = await getAdminAnalytics(parseRange(req.query.range));
    res.status(200).json({ data });
  } catch (err) {
    next(err);
  }
}
