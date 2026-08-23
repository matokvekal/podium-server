// Routes for THE ROUTE ATTACHED TO AN EVENT.
//
// Mounted by event.routes.ts at "/:eventId/route", so every path below is
// /api/v1/events/:eventId/route.
//
// All three verbs live here. Before this refactor the POST was registered twice — once by
// event.routes.ts directly and once through this router — and Express silently used the first
// one, so the handler in this file never ran. One registration per verb now.

import { Router } from "express";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../middleware/requireAuth.js";
import {
  deleteEventRouteController,
  getEventRouteController,
  setEventRouteController,
} from "../controllers/eventRoute.controller.js";

// mergeParams: true so :eventId from the parent mount (event.routes.ts) is visible here.
export const eventRouteRouter = Router({ mergeParams: true });

// GET /api/v1/events/:eventId/route
// Optional auth, same as GET /:eventId: a public event's route is visible to a stranger;
// getEventRouteGeometry still 403s a private event for anyone but its owner.
eventRouteRouter.get("/", optionalAuth, getEventRouteController);

// POST /api/v1/events/:eventId/route
eventRouteRouter.post("/", requireAuth, deduplicateClientAction, setEventRouteController);

// DELETE /api/v1/events/:eventId/route
eventRouteRouter.delete("/", requireAuth, deduplicateClientAction, deleteEventRouteController);
