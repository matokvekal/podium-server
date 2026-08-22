import { Router } from "express";
import { optionalAuth, requireAuth } from "../../middleware/requireAuth.js";
import { getRouteHandler, setRouteHandler } from "./routes.controller.js";

// mergeParams: true so :eventId from the parent mount (event.routes.ts) is visible here —
// same pattern participants.routes.ts uses.
export const routesRouter = Router({ mergeParams: true });

// Owner only, same auth pattern as PATCH /:eventId.
routesRouter.post("/", requireAuth, setRouteHandler);
// Optional auth, same as GET /:eventId: a public event's route is visible to a stranger;
// getEventRoute still 403s a private event for anyone but its owner.
routesRouter.get("/", optionalAuth, getRouteHandler);
