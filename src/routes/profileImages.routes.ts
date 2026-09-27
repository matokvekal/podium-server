// The profile-image gallery catalog — mounted by app.ts at "/api/v1/profile-images".
//
// One endpoint, public: it lists static filenames an operator has manually placed in
// PROFILE_IMAGES_DIR, with no user data in the response. See config/profile-images.ts.

import { Router } from "express";
import { listProfileImagesController } from "../controllers/profile-images.controller.js";

export const profileImagesRouter = Router();

// GET /api/v1/profile-images
profileImagesRouter.get("/", listProfileImagesController);
