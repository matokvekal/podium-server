// Routes for THE ROUTE BUILDER.
//
// Mounted by app.ts at "/api/v1/route-builder". Saving a built route is NOT here — it goes
// through the existing POST /api/v1/routes (library) or POST /api/v1/events/:id/route (a ride).

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  getRouteBuilderConfigController,
  routeSegmentController,
} from "../controllers/routeBuilder.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

/**
 * Per rider, not per IP. A rider building a route sends one request per new or moved point —
 * 60 a minute is far above hand speed, and well below what would load a shared BRouter.
 */
export const ROUTE_SEGMENTS_PER_MINUTE = 60;

const segmentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ROUTE_SEGMENTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.auth?.userId ?? "unauthenticated"}`,
  message: { error: "Too many route requests", message: "Too many route requests — wait a moment." },
});

export const routeBuilderRouter = Router();

// GET /api/v1/route-builder/config — whether auto-routing is on (else: straight lines only).
routeBuilderRouter.get("/config", getRouteBuilderConfigController);

// POST /api/v1/route-builder/segment — { from, to, profile } -> { points, distanceM }
routeBuilderRouter.post("/segment", requireAuth, segmentLimiter, routeSegmentController);
