// The System Admin's per-ride rider-cap API (sql/060) — mounted by app.ts at
// "/api/v1/admin/rides". Same two gates, same order, as adminRideImages.routes.ts: requireAuth
// (401), then requireAdminAnalytics (403 for anyone but env.ADMIN_ANALYTICS_EMAILS).

import { Router } from "express";
import { requireAdminAnalytics } from "../adminAnalytics/adminAnalytics.auth.js";
import {
  adminListRidesController,
  adminSetRideMaxParticipantsController,
} from "../controllers/adminRides.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const adminRidesRouter = Router();

adminRidesRouter.use(requireAuth, requireAdminAnalytics);

adminRidesRouter.get("/", adminListRidesController);
adminRidesRouter.patch("/:eventId", adminSetRideMaxParticipantsController);
