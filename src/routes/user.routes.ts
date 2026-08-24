// Routes for USERS — mounted by app.ts at "/api/v1/users".

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  followController,
  listFollowingController,
  unfollowController,
} from "../controllers/team.controller.js";
import {
  getMeController,
  redeemCouponController,
  updateMeController,
} from "../controllers/user.controller.js";
import {
  deleteAvatarController,
  deleteCoverController,
  listImagePresetsController,
  putAvatarController,
  putCoverController,
} from "../controllers/user-image.controller.js";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const userRouter = Router();

/**
 * Writing an image is far more expensive than reading a profile — it validates, decodes a
 * header and touches the disk — so it gets its own budget rather than sharing the global
 * 300/15min. Keyed per user, not per IP: these routes all require a token, and an office or
 * a mobile carrier behind one address must not throttle each other. Same shape as
 * locationBatchLimiter in event.routes.ts.
 */
const userImageWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.auth?.userId}`,
});

// GET /api/v1/users/me
userRouter.get("/me", requireAuth, getMeController);

// POST /api/v1/users/me/redeem
// Beta/promo codes. deduplicateClientAction guards a replayed redemption.
userRouter.post("/me/redeem", requireAuth, deduplicateClientAction, redeemCouponController);

// PATCH /api/v1/users/me
userRouter.patch("/me", requireAuth, updateMeController);

// GET /api/v1/users/image-presets
// The built-in avatar/cover art this server will accept an id for. Public and static — no
// user data, and a sign-in or onboarding screen may want it before there is a token.
// Declared before "/:userId/..." so it is never read as a user id.
userRouter.get("/image-presets", listImagePresetsController);

// PUT /api/v1/users/me/avatar     JSON { presetId } to choose a preset, or raw image bytes
// DELETE /api/v1/users/me/avatar  back to the Google picture
//
// "/me" only, deliberately: the user id comes from the access token, so there is no route
// through which one rider could change another rider's images.
userRouter.put("/me/avatar", requireAuth, userImageWriteLimiter, putAvatarController);
userRouter.delete("/me/avatar", requireAuth, userImageWriteLimiter, deleteAvatarController);

// PUT/DELETE /api/v1/users/me/cover
userRouter.put("/me/cover", requireAuth, userImageWriteLimiter, putCoverController);
userRouter.delete("/me/cover", requireAuth, userImageWriteLimiter, deleteCoverController);

// GET /api/v1/users/me/following
// Following an organizer. "/me/following" and "/:userId/follow" are unambiguous either way,
// since /me is not a number.
userRouter.get("/me/following", requireAuth, listFollowingController);

// PUT /api/v1/users/:userId/follow
userRouter.put("/:userId/follow", requireAuth, followController);

// DELETE /api/v1/users/:userId/follow
userRouter.delete("/:userId/follow", requireAuth, unfollowController);
