// The server-side gate for GET /api/v1/admin/analytics. The /admin2026 URL is NOT a security
// boundary — this is. The access token carries only a userId, so we look up every email on the
// caller's auth_identities and check it against env.ADMIN_ANALYTICS_EMAILS.
//
//   no token            -> 401 (requireAuth, which runs first)
//   token, wrong person -> 403 here
//   token, the admin    -> through

import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { selectUserEmails } from "../queries/user.queries.js";

/** Pure: does any of these emails match the configured admin list? Case-insensitive. */
export function isAdminEmail(emails: readonly string[]): boolean {
  const allowed = env.ADMIN_ANALYTICS_EMAILS; // already lower-cased in env.ts
  return emails.some((e) => allowed.includes(e.trim().toLowerCase()));
}

/**
 * Middleware. Assumes requireAuth has already populated req.auth. Throws 403 (never a partial
 * response) unless the caller is the analytics admin.
 */
export async function requireAdminAnalytics(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.auth?.userId;
    if (userId == null) {
      // requireAuth should have caught this; belt-and-braces so a mis-ordered route can't leak.
      throw new ApiError(401, "Not authenticated");
    }
    const emails = await selectUserEmails(userId);
    if (!isAdminEmail(emails)) {
      logger.warn({ userId }, "admin-analytics: access denied for non-admin");
      throw new ApiError(403, "Not authorized");
    }
    next();
  } catch (err) {
    next(err);
  }
}
