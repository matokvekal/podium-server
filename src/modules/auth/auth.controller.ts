import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env.js";
import {
  devLoginSchema,
  googleAuthSchema,
  refreshSchema,
  smsRequestSchema,
  smsVerifySchema,
} from "./auth.schemas.js";
import {
  authenticateAsDevUser,
  authenticateWithGoogle,
  logoutAll as logoutAllSessions,
  logout as logoutSession,
  refreshTokens,
  requestSmsOtp,
  verifySmsOtp,
} from "./auth.service.js";
import { enabledAuthProviders } from "./auth-providers.js";
import type { SessionContext } from "./session.service.js";

function sessionContext(req: Request): SessionContext {
  return { deviceInfo: req.get("user-agent") ?? null, ipAddress: req.ip ?? null };
}

export async function google(req: Request, res: Response, next: NextFunction) {
  try {
    const { idToken } = googleAuthSchema.parse(req.body);
    const result = await authenticateWithGoogle(idToken, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function smsRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = smsRequestSchema.parse(req.body);
    const result = await requestSmsOtp(phone, req.ip ?? null);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function smsVerify(req: Request, res: Response, next: NextFunction) {
  try {
    const { challengeId, code } = smsVerifySchema.parse(req.body);
    const result = await verifySmsOtp(challengeId, code, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await refreshTokens(refreshToken, sessionContext(req));
    res.status(200).json(tokens);
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await logoutSession(req.auth!.sessionId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction) {
  try {
    await logoutAllSessions(req.auth!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export function config(_req: Request, res: Response) {
  // `devLogin` tells the client whether to offer the developer shortcut, so the button
  // disappears by itself against any server that does not have it switched on.
  // ⚠ Remove `devLogin` with the rest of the dev sign-in — see README.md.
  res.status(200).json({ providers: enabledAuthProviders, devLogin: env.DEV_LOGIN_ENABLED });
}

/**
 * ⚠ TEMPORARY DEVELOPMENT AID — DELETE BEFORE PRODUCTION. See README.md > Developer sign-in.
 * Mounted behind requireDevLoginEnabled, which 404s unless dev login is on and this is not
 * production.
 */
export async function devLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { role, key } = devLoginSchema.parse(req.body ?? {});
    const result = await authenticateAsDevUser({ role, key }, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
