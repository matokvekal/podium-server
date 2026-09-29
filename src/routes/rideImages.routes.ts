// The public ride-image catalog — mounted by app.ts at "/api/v1/ride-images". Any authenticated
// rider: the Create/Edit Ride picker (filtering to selectable) and every card/detail page
// resolving an existing ride's cover (which must NOT filter to selectable — see sql/052).

import { Router } from "express";
import { listRideImagesController } from "../controllers/rideImages.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const rideImagesRouter = Router();

rideImagesRouter.get("/", requireAuth, listRideImagesController);
