// Routes for EVENTS — mounted by app.ts at "/api/v1/events".
//
// Every path below is written out in full in the comment above it, so searching for
// "/api/v1/events/:eventId/status" lands here and the controller name next to it tells you
// which file to open for a breakpoint.
//
// Two sub-routers are mounted at the bottom for the paths that have several verbs of their
// own: participants and the event's route.

import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../middleware/requireAuth.js";
import {
  assignRidersController,
  createGroupController,
  deleteGroupController,
  listGroupsController,
  updateGroupController,
} from "../controllers/group.controller.js";
import {
  getParticipantTrackController,
  getResultsController,
  getTracksController,
} from "../controllers/result.controller.js";
import { linkEventTeamController } from "../controllers/team.controller.js";
import {
  cancelEventController,
  changeEventStatusController,
  createEventController,
  getEventByCodeController,
  getEventController,
  getLiveController,
  joinEventController,
  listEventsController,
  listPublicEventsController,
  pauseEventController,
  postLocationBatchController,
  updateEventController,
} from "../controllers/event.controller.js";
import { eventRouteRouter } from "./eventRoute.routes.js";
import { participantRouter } from "./participant.routes.js";

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

/**
 * Polled every 5-10s per viewer (no websocket in this codebase). Keyed on userId when signed
 * in, IP otherwise — a public event's live map can be watched by many different anonymous
 * viewers, so lumping them into one "unauthenticated" bucket (as locationBatchLimiter above
 * does, safely, since ingest always requires auth) would throttle unrelated strangers together.
 */
const liveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.auth?.userId ? `user:${req.auth.userId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`,
});

// ---- the three frozen Android-transmitter endpoints ---------------------------------------
// Contract-frozen: the shipped Android app calls these. Never change path, body or response.
// deduplicateClientAction is deliberately absent: join is idempotent by upsert, and location
// ingest is idempotent by nature.

// GET /api/v1/events/by-code/:code
// Unauthenticated: the transmitter looks this up right after a QR scan / code entry, before
// the rider has necessarily signed in yet (see transmiter/REQUIREMENTS.md).
eventRouter.get("/by-code/:code", getEventByCodeController);

// POST /api/v1/events/join
eventRouter.post("/join", requireAuth, joinEventController);

// POST /api/v1/events/:eventId/locations/batch
eventRouter.post(
  "/:eventId/locations/batch",
  requireAuth,
  locationBatchLimiter,
  postLocationBatchController,
);

// GET /api/v1/events/:eventId/live
eventRouter.get("/:eventId/live", optionalAuth, liveLimiter, getLiveController);

// ---- ownership, CRUD and the status workflow ----------------------------------------------

// POST /api/v1/events
eventRouter.post("/", requireAuth, deduplicateClientAction, createEventController);

// GET /api/v1/events
eventRouter.get("/", requireAuth, listEventsController);

// GET /api/v1/events/public
// Registered before the single-segment "/:eventId" so a request for it is never swallowed
// by the param route.
eventRouter.get("/public", listPublicEventsController);

// GET /api/v1/events/:eventId
// Optional auth, not required: a public event is viewable by a stranger, same as its card on
// the guest home screen. getEventForViewer still 403s a private event for anyone but its
// owner — this only widens who is *allowed to ask*, not what a private event reveals.
eventRouter.get("/:eventId", optionalAuth, getEventController);

// PATCH /api/v1/events/:eventId
eventRouter.patch("/:eventId", requireAuth, deduplicateClientAction, updateEventController);

// PATCH /api/v1/events/:eventId/status
eventRouter.patch(
  "/:eventId/status",
  requireAuth,
  deduplicateClientAction,
  changeEventStatusController,
);

// PATCH /api/v1/events/:eventId/pause
eventRouter.patch("/:eventId/pause", requireAuth, deduplicateClientAction, pauseEventController);

// DELETE /api/v1/events/:eventId
eventRouter.delete("/:eventId", requireAuth, deduplicateClientAction, cancelEventController);

// ---- results and history -------------------------------------------------------------------
// optionalAuth, same as the event detail: a public ride's results are readable by anyone the
// organizer has opened them to, and getEventResults does the tiering.

// GET /api/v1/events/:eventId/results
eventRouter.get("/:eventId/results", optionalAuth, getResultsController);

// GET /api/v1/events/:eventId/tracks
eventRouter.get("/:eventId/tracks", optionalAuth, getTracksController);

// GET /api/v1/events/:eventId/tracks/:participantId
eventRouter.get("/:eventId/tracks/:participantId", optionalAuth, getParticipantTrackController);

// ---- ride groups ---------------------------------------------------------------------------
// One event ridden as 2-4 groups. Reading follows the riders-list rules; every mutation is
// owner-only.

// GET /api/v1/events/:eventId/groups
eventRouter.get("/:eventId/groups", optionalAuth, listGroupsController);

// POST /api/v1/events/:eventId/groups
eventRouter.post("/:eventId/groups", requireAuth, deduplicateClientAction, createGroupController);

// PATCH /api/v1/events/:eventId/groups/:groupId
eventRouter.patch(
  "/:eventId/groups/:groupId",
  requireAuth,
  deduplicateClientAction,
  updateGroupController,
);

// DELETE /api/v1/events/:eventId/groups/:groupId
eventRouter.delete(
  "/:eventId/groups/:groupId",
  requireAuth,
  deduplicateClientAction,
  deleteGroupController,
);

// POST /api/v1/events/:eventId/groups/assign
// Bulk by design — the client has always assigned riders to a group many at a time.
// Safe after "/:groupId" only because nothing registers POST /:eventId/groups/:groupId; if
// that is ever added, this must move above it or "assign" will be read as a group id.
eventRouter.post(
  "/:eventId/groups/assign",
  requireAuth,
  deduplicateClientAction,
  assignRidersController,
);

// PATCH /api/v1/events/:eventId/team
// Links this ride into a team's schedule (or unlinks it with teamId: null).
eventRouter.patch("/:eventId/team", requireAuth, deduplicateClientAction, linkEventTeamController);

// ---- sub-routers ---------------------------------------------------------------------------

// /api/v1/events/:eventId/participants/*  -> participant.routes.ts
eventRouter.use("/:eventId/participants", participantRouter);

// /api/v1/events/:eventId/route           -> eventRoute.routes.ts  (GET, POST, DELETE)
eventRouter.use("/:eventId/route", eventRouteRouter);
