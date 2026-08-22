import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { deduplicateClientAction } from "../../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../../middleware/requireAuth.js";
import {
  assignRidersHandler,
  createGroupHandler,
  deleteGroupHandler,
  listGroupsHandler,
  updateGroupHandler,
} from "../groups/group.controller.js";
import { participantsRouter } from "../participants/participants.routes.js";
import { routesRouter } from "../routes/routes.routes.js";
import {
  getParticipantTrackHandler,
  getResultsHandler,
  getTracksHandler,
} from "../results/results.controller.js";
import { attachRouteHandler, detachRouteHandler } from "../routes/route.controller.js";
import { linkEventTeamHandler } from "../teams/team.controller.js";
import {
  cancelEventHandler,
  changeEventStatusHandler,
  createEventHandler,
  getEventByCode,
  getEventHandler,
  getLiveHandler,
  join,
  leaveEventHandler,
  listEventsHandler,
  listPublicEventsHandler,
  pauseEventHandler,
  postLocationBatch,
  updateEventHandler,
} from "./event.controller.js";

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
eventRouter.post("/:eventId/leave", requireAuth, leaveEventHandler);
eventRouter.post("/:eventId/locations/batch", requireAuth, locationBatchLimiter, postLocationBatch);

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
eventRouter.get("/:eventId/live", optionalAuth, liveLimiter, getLiveHandler);

// Ownership, CRUD and the status workflow — milestone 2. "/public" is registered before the
// single-segment "/:eventId" so a request for it is never swallowed by the param route.
//
// deduplicateClientAction sits on the mutations below, never on the three frozen Android
// endpoints above: join is idempotent by upsert and location ingest is idempotent by nature.
eventRouter.post("/", requireAuth, deduplicateClientAction, createEventHandler);
eventRouter.get("/", requireAuth, listEventsHandler);
eventRouter.get("/public", listPublicEventsHandler);
// Optional auth, not required: a public event is viewable by a stranger, same as its card
// on the guest home screen. getEventForViewer still 403s a private event for anyone but its
// owner — this only widens who is *allowed to ask*, not what a private event reveals.
eventRouter.get("/:eventId", optionalAuth, getEventHandler);
eventRouter.patch("/:eventId", requireAuth, deduplicateClientAction, updateEventHandler);
eventRouter.patch(
  "/:eventId/status",
  requireAuth,
  deduplicateClientAction,
  changeEventStatusHandler,
);
eventRouter.patch("/:eventId/pause", requireAuth, deduplicateClientAction, pauseEventHandler);
eventRouter.delete("/:eventId", requireAuth, deduplicateClientAction, cancelEventHandler);

// Results and history. optionalAuth, same as the event detail: a public ride's results are
// readable by anyone the organizer has opened them to, and getEventResults does the tiering.
eventRouter.get("/:eventId/results", optionalAuth, getResultsHandler);
eventRouter.get("/:eventId/tracks", optionalAuth, getTracksHandler);
eventRouter.get("/:eventId/tracks/:participantId", optionalAuth, getParticipantTrackHandler);

// The track an organizer picked, uploaded or copied from another ride. Owner-only: the route
// itself lives in the routes module, this only says which one this event runs on.
eventRouter.post("/:eventId/route", requireAuth, deduplicateClientAction, attachRouteHandler);
eventRouter.delete("/:eventId/route", requireAuth, deduplicateClientAction, detachRouteHandler);

// Ride groups: one event ridden as 2-4 groups. Reading follows the riders-list rules; every
// mutation is owner-only.
eventRouter.get("/:eventId/groups", optionalAuth, listGroupsHandler);
eventRouter.post("/:eventId/groups", requireAuth, deduplicateClientAction, createGroupHandler);
eventRouter.patch(
  "/:eventId/groups/:groupId",
  requireAuth,
  deduplicateClientAction,
  updateGroupHandler,
);
eventRouter.delete(
  "/:eventId/groups/:groupId",
  requireAuth,
  deduplicateClientAction,
  deleteGroupHandler,
);
// Bulk by design — the client has always assigned riders to a group many at a time.
eventRouter.post(
  "/:eventId/groups/assign",
  requireAuth,
  deduplicateClientAction,
  assignRidersHandler,
);

// Links this ride into a team's schedule (or unlinks it with teamId: null).
eventRouter.patch("/:eventId/team", requireAuth, deduplicateClientAction, linkEventTeamHandler);

eventRouter.use("/:eventId/participants", participantsRouter);
eventRouter.use("/:eventId/route", routesRouter);
