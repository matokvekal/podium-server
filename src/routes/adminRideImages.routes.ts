// The System Admin's ride-image management API — mounted by app.ts at
// "/api/v1/admin/ride-images". Same two gates, same order, as adminAnalytics.routes.ts:
// requireAuth (401 for no/forged token), then requireAdminAnalytics (403 for anyone but
// env.ADMIN_ANALYTICS_EMAILS) — reusing that exact middleware is the point: this is not a new
// admin role or a new admin page, just another private endpoint the same one administrator can
// reach from /admin2026.

import { Router } from "express";
import { requireAdminAnalytics } from "../adminAnalytics/adminAnalytics.auth.js";
import {
  adminDeleteRideImageController,
  adminListRideImagesController,
  adminSetSelectableController,
  adminUploadRideImageController,
} from "../controllers/rideImages.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const adminRideImagesRouter = Router();

adminRideImagesRouter.use(requireAuth, requireAdminAnalytics);

adminRideImagesRouter.get("/", adminListRideImagesController);
adminRideImagesRouter.post("/", adminUploadRideImageController);
adminRideImagesRouter.patch("/:key", adminSetSelectableController);
adminRideImagesRouter.delete("/:key", adminDeleteRideImageController);
