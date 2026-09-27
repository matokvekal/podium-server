// Public, best-effort site-traffic ingest — mounted by app.ts at "/api/v1/analytics".
//
// optionalAuth: a page view is meaningful from both a signed-in rider and an anonymous visitor,
// so this never rejects for a missing/expired token. Rate-limited the same way the live-map
// poll is (liveLimiter in event.routes.ts) — keyed on the signed-in user when there is one,
// otherwise on IP, so anonymous visitors sharing a NAT don't get lumped into one bucket with a
// stranger. A rider browsing normally is nowhere near this limit; only a scripted hammer is.

import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { createPageViewController } from "../controllers/analytics.controller.js";
import { optionalAuth } from "../middleware/requireAuth.js";

export const analyticsRouter = Router();

const pageViewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.auth?.userId ? `user:${req.auth.userId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`,
});

analyticsRouter.post("/page-view", optionalAuth, pageViewLimiter, createPageViewController);
