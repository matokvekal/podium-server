import type { NextFunction, Request, Response } from "express";
import type { User } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { traceLog } from "../../lib/trace-log.js";
import { updateProfileSchema } from "./user.schemas.js";
import { findUserById, needsProfile, updateProfile } from "./user.service.js";

function toProfile(user: User) {
  return {
    id: user.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    nickname: user.nickname,
    emergencyPhone: user.emergencyPhone,
    requiresProfile: needsProfile(user),
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
    res.status(200).json({ data: toProfile(user) });
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
