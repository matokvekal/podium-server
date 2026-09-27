// Controller for public, best-effort site-traffic tracking — /api/v1/analytics.
// See src/routes/analytics.routes.ts (optionalAuth + rate limit) and
// src/services/analytics.service.ts (the PAGE_VIEW write, via trackAuditEvent — non-fatal).

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { pageViewSchema } from "../schemas/analytics.schemas.js";
import { recordPageView } from "../services/analytics.service.js";

// POST /api/v1/analytics/page-view   { path, visitorId, sessionId, referrer? }
export async function createPageViewController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = pageViewSchema.parse(req.body);
    traceLog("analytics.controller.createPageViewController", { path: input.path });
    await recordPageView(input, {
      userId: req.auth?.userId ?? null,
      userAgent: req.get("user-agent") ?? "",
    });
    res.status(202).json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
}
