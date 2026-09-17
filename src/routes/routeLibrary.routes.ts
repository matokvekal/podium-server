// Routes for THE ROUTE LIBRARY.
//
// Mounted by app.ts at "/api/v1/routes". The route attached to one specific event is a
// different surface — see eventRoute.routes.ts.

import { Router } from "express";
import {
  addRouteFavoriteController,
  createRouteController,
  deleteRouteController,
  getRouteController,
  likeRouteController,
  listMyRoutesController,
  listPublicRoutesController,
  removeRouteFavoriteController,
  updateRouteController,
} from "../controllers/routeLibrary.controller.js";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { optionalAuth, requireAuth } from "../middleware/requireAuth.js";

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

// POST   /api/v1/routes/:routeId/like
// POST   /api/v1/routes/:routeId/favorite
// DELETE /api/v1/routes/:routeId/favorite
//
// Two-segment paths, so they must be registered before the single-segment "/:routeId" — the
// same ordering rule "/public" follows above.
//
// Liking is once and permanent and there is deliberately no DELETE for it; a favourite is the
// rider's own bookmark and toggles freely. Both require a real account: an anonymous like
// would be uncountable and an anonymous bookmark would have nowhere to live.
//
// NOT wrapped in deduplicateClientAction. Both are already idempotent at the database (UNIQUE
// on (route_id, user_id) + ON CONFLICT DO NOTHING), so a replayed request is harmless, and the
// dedup middleware's 409 would make a retry look like a failure to the card.
routeLibraryRouter.post("/:routeId/like", requireAuth, likeRouteController);
routeLibraryRouter.post("/:routeId/favorite", requireAuth, addRouteFavoriteController);
routeLibraryRouter.delete("/:routeId/favorite", requireAuth, removeRouteFavoriteController);

// GET /api/v1/routes/:routeId
// Optional auth: a published route opens for a guest; getRouteForViewer still 404s an
// unpublished one for anyone but its owner.
routeLibraryRouter.get("/:routeId", optionalAuth, getRouteController);

// PATCH /api/v1/routes/:routeId
routeLibraryRouter.patch("/:routeId", requireAuth, deduplicateClientAction, updateRouteController);

// DELETE /api/v1/routes/:routeId
routeLibraryRouter.delete("/:routeId", requireAuth, deduplicateClientAction, deleteRouteController);
