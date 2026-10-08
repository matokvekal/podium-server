// Routes for EVENT COMPLETION MEDALS — mounted by app.ts at "/api/v1/medals".
//
// The caller's own medals only: the user always comes from the bearer token (req.auth), never
// from the URL or body. There is deliberately no endpoint that AWARDS a medal — that is server
// business logic run when a ride finishes (services/eventMedals.service.ts).

import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { listMyMedalsController, markMyMedalsSeenController } from "./medals.controller.js";

export const medalsRouter = Router();

// GET /api/v1/medals/me?limit=20&before=<cursor>
medalsRouter.get("/me", requireAuth, listMyMedalsController);

// POST /api/v1/medals/me/seen   body: { eventIds?: string[] }
medalsRouter.post("/me/seen", requireAuth, markMyMedalsSeenController);
