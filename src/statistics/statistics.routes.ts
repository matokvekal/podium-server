// Routes for RIDER STATISTICS — mounted by app.ts at "/api/v1/statistics".
//
// READ-ONLY, ISOLATED SUBSYSTEM. Both routes require sign-in: a leaderboard entry and a
// lifetime total are the rider's own participation history, not something a signed-out visitor
// browses — see AppDrawer.tsx's own gating for the client-side half of that rule. Nothing under
// src/statistics/ writes to events, routes, or users — see statistics.service.ts's own header.

import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getLeaderboardController, getMyStatisticsController } from "./statistics.controller.js";

export const statisticsRouter = Router();

// GET /api/v1/statistics/me
statisticsRouter.get("/me", requireAuth, getMyStatisticsController);

// GET /api/v1/statistics/leaderboard
statisticsRouter.get("/leaderboard", requireAuth, getLeaderboardController);
