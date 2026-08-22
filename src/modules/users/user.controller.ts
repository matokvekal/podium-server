import type { NextFunction, Request, Response } from "express";
import type { User } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { traceLog } from "../../lib/trace-log.js";
import { ACCOUNT_CAPABILITIES } from "../../authz/capabilities.js";
import { buildActor } from "../../authz/actor.js";
import { redeemCoupon } from "../../authz/coupons.js";
import { accountCapabilitiesFor } from "../../authz/policy.js";
import { countEventsCreatedSince } from "../events/event.queries.js";
import { countTeamsForOwner } from "../teams/team.queries.js";
import { redeemCouponSchema, updateProfileSchema } from "./user.schemas.js";
import { findUserById, needsProfile, updateProfile } from "./user.service.js";

function toProfile(user: User) {
  return {
    id: user.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    nickname: user.nickname,
    emergencyPhone: user.emergencyPhone,
    avatarUrl: user.avatarUrl,
    requiresProfile: needsProfile(user),
  };
}

/**
 * The account half of the contract with the client: what this person may do, what plan they
 * are on, what it allows, and how much of it they have used.
 *
 * Usage is included so a client can say "3 of 3 rides used this week" and prompt an upgrade
 * without knowing what a plan is, and without a second round trip.
 */
async function toAccount(user: User) {
  const actor = await buildActor(user.id);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [eventsThisWeek, teamsOwned] = await Promise.all([
    countEventsCreatedSince(user.id, weekAgo),
    countTeamsForOwner(user.id),
  ]);

  return {
    ...toProfile(user),
    capabilities: accountCapabilitiesFor(actor, ACCOUNT_CAPABILITIES),
    plan: {
      code: actor.entitlements.plan.code,
      label: actor.entitlements.plan.label,
      features: [...actor.entitlements.features],
      limits: actor.entitlements.limits,
    },
    usage: { eventsThisWeek, teamsOwned },
    /** Live grants, for an account screen that can show "Pro until 12 March". */
    grants: actor.entitlements.grants,
  };
}

/**
 * The web app needs this on a cold start: it has a stored session but knows nothing about
 * the rider yet. Additive to the frozen contract — the Android app does not call it.
 */
export async function getMe(req: Request, res: Response, next: NextFunction) {
  traceLog("user.controller.getMe", { userId: req.auth!.userId });
  try {
    const user = await findUserById(req.auth!.userId);
    if (!user) {
      // A valid token for a user row that no longer exists. Not 404 — the caller's identity
      // is what is gone, so make them sign in again.
      throw new ApiError(401, "This account no longer exists");
    }
    res.status(200).json({ data: await toAccount(user) });
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: Request, res: Response, next: NextFunction) {
  traceLog("user.controller.updateMe", { userId: req.auth!.userId });
  try {
    const input = updateProfileSchema.parse(req.body);
    const user = await updateProfile(req.auth!.userId, input);
    res.status(200).json({ data: toProfile(user) });
  } catch (err) {
    next(err);
  }
}

/**
 * Redeeming a beta/promo code. The endpoint knows nothing about plans or pricing — it hands
 * the code to the coupon module, which writes a grant like any other source would.
 */
export async function redeemCouponHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = redeemCouponSchema.parse(req.body);
    traceLog("user.controller.redeemCouponHandler", { userId: req.auth!.userId });
    const result = await redeemCoupon(req.auth!.userId, code);
    const user = await findUserById(req.auth!.userId);
    if (!user) throw new ApiError(401, "This account no longer exists");
    // The refreshed account comes back with it, so the client does not have to re-fetch to
    // discover what the code actually unlocked.
    res.status(200).json({ data: { redeemed: result, account: await toAccount(user) } });
  } catch (err) {
    next(err);
  }
}
