// Routes for THE ROUTE LIBRARY.
//
// Mounted by app.ts at "/api/v1/routes". The route attached to one specific event is a
// different surface — see eventRoute.routes.ts.

import { Router } from "express";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../middleware/requireAuth.js";
import {
  createRouteController,
  deleteRouteController,
  getRouteController,
  listMyRoutesController,
  listPublicRoutesController,
  updateRouteController,
} from "../controllers/routeLibrary.controller.js";

export const routeLibraryRouter = Router();

// GET /api/v1/routes/public
//
// Registered before "/:routeId", or the param route swallows it — same ordering rule the
// event router follows for "/public".
//
// Unauthenticated on purpose: browsing the track library is the app's front door for someone
// with no account ("see many old rides just to see track maps"), exactly like the public
// event list.
routeLibraryRouter.get("/public", listPublicRoutesController);

// POST /api/v1/routes
routeLibraryRouter.post("/", requireAuth, deduplicateClientAction, createRouteController);

// GET /api/v1/routes
routeLibraryRouter.get("/", requireAuth, listMyRoutesController);

// GET /api/v1/routes/:routeId
// Optional auth: a published route opens for a guest; getRouteForViewer still 404s an
// unpublished one for anyone but its owner.
routeLibraryRouter.get("/:routeId", optionalAuth, getRouteController);

// PATCH /api/v1/routes/:routeId
routeLibraryRouter.patch("/:routeId", requireAuth, deduplicateClientAction, updateRouteController);

// DELETE /api/v1/routes/:routeId
routeLibraryRouter.delete("/:routeId", requireAuth, deduplicateClientAction, deleteRouteController);
