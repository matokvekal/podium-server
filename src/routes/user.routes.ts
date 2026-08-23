// Routes for USERS — mounted by app.ts at "/api/v1/users".

import { Router } from "express";
import {
  followController,
  listFollowingController,
  unfollowController,
} from "../controllers/team.controller.js";
import { getMeController, redeemCouponController, updateMeController } from "../controllers/user.controller.js";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const userRouter = Router();

// GET /api/v1/users/me
userRouter.get("/me", requireAuth, getMeController);

// POST /api/v1/users/me/redeem
// Beta/promo codes. deduplicateClientAction guards a replayed redemption.
userRouter.post("/me/redeem", requireAuth, deduplicateClientAction, redeemCouponController);

// PATCH /api/v1/users/me
userRouter.patch("/me", requireAuth, updateMeController);

// GET /api/v1/users/me/following
// Following an organizer. "/me/following" and "/:userId/follow" are unambiguous either way,
// since /me is not a number.
userRouter.get("/me/following", requireAuth, listFollowingController);

// PUT /api/v1/users/:userId/follow
userRouter.put("/:userId/follow", requireAuth, followController);

// DELETE /api/v1/users/:userId/follow
userRouter.delete("/:userId/follow", requireAuth, unfollowController);
