import { Router } from "express";
import { deduplicateClientAction } from "../../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../../middleware/requireAuth.js";
import {
  createRouteHandler,
  deleteRouteHandler,
  getRouteHandler,
  listMyRoutesHandler,
  listPublicRoutesHandler,
  updateRouteHandler,
} from "./route.controller.js";

export const routeRouter = Router();

// "/public" before "/:routeId", or the param route swallows it — same ordering rule the
// event router follows for "/public".
//
// Unauthenticated on purpose: browsing the track library is the app's front door for someone
// with no account ("see many old rides just to see track maps"), exactly like the public
// event list.
routeRouter.get("/public", listPublicRoutesHandler);

routeRouter.post("/", requireAuth, deduplicateClientAction, createRouteHandler);
routeRouter.get("/", requireAuth, listMyRoutesHandler);

// Optional auth: a published route opens for a guest; getRouteForViewer still 404s an
// unpublished one for anyone but its owner.
routeRouter.get("/:routeId", optionalAuth, getRouteHandler);
routeRouter.patch("/:routeId", requireAuth, deduplicateClientAction, updateRouteHandler);
routeRouter.delete("/:routeId", requireAuth, deduplicateClientAction, deleteRouteHandler);
