// The public ride-image catalog — mounted by app.ts at "/api/v1/ride-images". PUBLIC, no login:
// an anonymous visitor sees public rides, and every card must resolve that ride's cover from
// this catalog (an uploaded cover has no compiled fallback). It carries display metadata only —
// key, url, label, category, selectable, version (controllers/rideImages.controller.ts
// toPublicDto) — never file paths or admin fields. Archived/disabled keys are still listed so an
// existing ride keeps its picture. Upload / replace / archive live under /api/v1/admin/ride-images
// and stay System Admin only.

import { Router } from "express";
import { listRideImagesController } from "../controllers/rideImages.controller.js";

export const rideImagesRouter = Router();

rideImagesRouter.get("/", listRideImagesController);
