// The private admin dashboard API — mounted by app.ts at "/api/v1/admin".
//
// One endpoint. Two gates, in order: requireAuth (401 for no/forged token), then
// requireAdminAnalytics (403 for anyone but env.ADMIN_ANALYTICS_EMAILS). Nothing here is in
// the normal app's navigation; the /admin2026 page is reached by typing the URL, and the URL
// is not the security — the email check is.

import { Router } from "express";
import { requireAdminAnalytics } from "../adminAnalytics/adminAnalytics.auth.js";
import { getAdminAnalyticsController } from "../adminAnalytics/adminAnalytics.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const adminAnalyticsRouter = Router();

// GET /api/v1/admin/analytics?range=7|30|90|all
adminAnalyticsRouter.get(
  "/analytics",
  requireAuth,
  requireAdminAnalytics,
  getAdminAnalyticsController,
);
