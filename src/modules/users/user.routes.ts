import { Router } from "express";
import { deduplicateClientAction } from "../../middleware/clientActions.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  followHandler,
  listFollowingHandler,
  unfollowHandler,
} from "../teams/team.controller.js";
import { getMe, redeemCouponHandler, updateMe } from "./user.controller.js";

export const userRouter = Router();

userRouter.get("/me", requireAuth, getMe);
// Beta/promo codes. deduplicateClientAction guards a replayed redemption.
userRouter.post("/me/redeem", requireAuth, deduplicateClientAction, redeemCouponHandler);
userRouter.patch("/me", requireAuth, updateMe);

// Following an organizer. "/me/following" is registered before "/:userId/follow" would be
// reachable, and both are unambiguous anyway since /me is not a number.
userRouter.get("/me/following", requireAuth, listFollowingHandler);
userRouter.put("/:userId/follow", requireAuth, followHandler);
userRouter.delete("/:userId/follow", requireAuth, unfollowHandler);
