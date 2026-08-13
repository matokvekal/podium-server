import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../../middleware/requireAuth.js";
import { getEventByCode, join, postLocationBatch } from "./event.controller.js";

export const eventRouter = Router();

/**
 * Location ingest is limited per rider, not per IP.
 *
 * Riders at an event share carrier NAT addresses, so the global per-IP limit counts a
 * whole peloton as one client and throttles real riders. The limiter runs after
 * requireAuth so req.auth.userId is available to key on.
 *
 * 120 windows of 15 minutes is generous on purpose: a rider transmitting every 30 s uses
 * ~30, and a rider leaving a dead zone uploads a burst of queued batches at once.
 */
const locationBatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // requireAuth runs first, so req.auth is always present here. The fallback exists only so
  // a future route ordering mistake fails loudly (everyone in one bucket) rather than
  // silently keying on nothing.
  keyGenerator: (req) => `user:${req.auth?.userId ?? "unauthenticated"}`,
});

// Unauthenticated: the transmitter looks this up right after a QR scan / code entry,
// before the rider has necessarily signed in yet (see transmiter/REQUIREMENTS.md).
eventRouter.get("/by-code/:code", getEventByCode);

eventRouter.post("/join", requireAuth, join);
eventRouter.post(
  "/:eventId/locations/batch",
  requireAuth,
  locationBatchLimiter,
  postLocationBatch,
);
