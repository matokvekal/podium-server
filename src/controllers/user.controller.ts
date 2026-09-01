import type { NextFunction, Request, Response } from "express";
import { buildActor } from "../authz/actor.js";
import { ACCOUNT_CAPABILITIES } from "../authz/capabilities.js";
import { redeemCoupon } from "../authz/coupons.js";
import { accountCapabilitiesFor } from "../authz/policy.js";
import type { User } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { traceLog } from "../lib/trace-log.js";
import { userImageFieldsOf } from "../lib/user-images.js";
import { countEventsCreatedSince } from "../queries/event.queries.js";
import { countTeamsForOwner } from "../queries/team.queries.js";
import { selectOwnContactDefaults } from "../queries/user.queries.js";
import { redeemCouponSchema, updateProfileSchema } from "../schemas/user.schemas.js";
import { findUserById, needsProfile, updateProfile } from "../services/user.service.js";

function isMissingRelationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  return code === "42P01";
}

/**
 * Pre-fill is a convenience; /users/me is how the app knows who is signed in. If reading the
 * caller's own identities fails for any reason, the right answer is an empty pre-fill, never a
 * broken account endpoint — the organizer simply types their number in.
 */
async function safeOwnContactDefaults(
  userId: number,
): Promise<{ email: string | null; phone: string | null }> {
  try {
    return await selectOwnContactDefaults(userId);
  } catch (err) {
    logger.warn({ userId, err }, "could not read own contact defaults; offering no pre-fill");
    return { email: null, phone: null };
  }
}

async function safeCountTeamsForOwner(userId: number): Promise<number> {
  try {
    return await countTeamsForOwner(userId);
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    logger.warn({ userId, err }, "teams table missing; reporting teamsOwned=0");
    return 0;
  }
}

/**
 * Exported so the avatar/cover routes can reply with exactly the same profile shape that
 * PATCH /users/me already returns — one serializer, so a client never has to care which
 * endpoint a profile came back from.
 *
 * `avatarUrl` keeps its name and meaning to every client that already reads it, and now
 * carries the rider's CURRENT avatar rather than only their Google photo: their upload,
 * else their chosen preset, else the Google picture, else null. `avatar`/`cover`/`coverUrl`
 * are additive — a client that ignores them is unaffected, and a user who has chosen
 * neither image gets exactly today's response with two nulls beside it.
 */
export function toProfile(user: User) {
  return {
    id: user.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    nickname: user.nickname,
    emergencyPhone: user.emergencyPhone,
    ...userImageFieldsOf(user),
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
  const [eventsThisWeek, teamsOwned, contactDefaults] = await Promise.all([
    countEventsCreatedSince(user.id, weekAgo),
    safeCountTeamsForOwner(user.id),
    safeOwnContactDefaults(user.id),
  ]);

  const { maxEventsPerWeek, maxParticipantsPerEvent, maxGroupsPerEvent } = actor.entitlements.limits;

  return {
    ...toProfile(user),
    capabilities: accountCapabilitiesFor(actor, ACCOUNT_CAPABILITIES),
    /**
     * The authoritative per-user limits (user_entitlements folded onto the plan). Top-level and
     * teams-free so a client can mirror exactly what the server enforces on create / join /
     * groups without reading `plan`. `plan.limits` still carries the same three plus
     * maxTeamsPerOwner for an account screen.
     */
    entitlements: { maxEventsPerWeek, maxParticipantsPerEvent, maxGroupsPerEvent },
    plan: {
      code: actor.entitlements.plan.code,
      label: actor.entitlements.plan.label,
      features: [...actor.entitlements.features],
      limits: actor.entitlements.limits,
    },
    usage: { eventsThisWeek, teamsOwned },
    /**
     * The caller's OWN sign-in email and phone, offered so the create-ride form can pre-fill
     * the optional per-ride contact fields instead of making an organizer retype what the app
     * already knows. See sql/025-event-contact.sql.
     *
     * Safe here and only here: /users/me is self-only and authenticated, so this tells the
     * caller nothing about themselves they did not already provide. It is NOT profile data and
     * must never appear on a response describing anybody else — and pre-filling a field is not
     * publishing. Nothing reaches a ride page unless the organizer saves the ride with the
     * value still in it.
     */
    contactDefaults,
    /** Live grants, for an account screen that can show "Pro until 12 March". */
    grants: actor.entitlements.grants,
  };
}

/**
 * The web app needs this on a cold start: it has a stored session but knows nothing about
 * the rider yet. Additive to the frozen contract — the Android app does not call it.
 */
// GET /api/v1/users/me
export async function getMeController(req: Request, res: Response, next: NextFunction) {
  traceLog("user.controller.getMeController", { userId: req.auth!.userId });
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

// PATCH /api/v1/users/me
export async function updateMeController(req: Request, res: Response, next: NextFunction) {
  traceLog("user.controller.updateMeController", { userId: req.auth!.userId });
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
// POST /api/v1/users/me/redeem
export async function redeemCouponController(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = redeemCouponSchema.parse(req.body);
    traceLog("user.controller.redeemCouponController", { userId: req.auth!.userId });
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
