import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import {
  googleAuthSchema,
  refreshSchema,
  smsRequestSchema,
  smsVerifySchema,
} from "../schemas/auth.schemas.js";
import {
  authenticateWithGoogle,
  logoutAll as logoutAllSessions,
  logout as logoutSession,
  refreshTokens,
  requestSmsOtp,
  verifySmsOtp,
} from "../services/auth.service.js";
import { enabledAuthProviders } from "../config/auth-providers.js";
import type { SessionContext } from "../services/session.service.js";

function sessionContext(req: Request): SessionContext {
  return { deviceInfo: req.get("user-agent") ?? null, ipAddress: req.ip ?? null };
}

// POST /api/v1/auth/google
export async function googleAuthController(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.googleAuthController");
  try {
    const { idToken } = googleAuthSchema.parse(req.body);
    const result = await authenticateWithGoogle(idToken, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/sms/request
export async function smsRequestController(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = smsRequestSchema.parse(req.body);
    traceLog("auth.controller.smsRequestController", { phone });
    const result = await requestSmsOtp(phone, req.ip ?? null);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/sms/verify
export async function smsVerifyController(req: Request, res: Response, next: NextFunction) {
  try {
    const { challengeId, code } = smsVerifySchema.parse(req.body);
    traceLog("auth.controller.smsVerifyController", { challengeId });
    const result = await verifySmsOtp(challengeId, code, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/refresh
export async function refreshController(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.refreshController");
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await refreshTokens(refreshToken, sessionContext(req));
    res.status(200).json(tokens);
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/logout
export async function logoutController(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.logoutController", { sessionId: req.auth!.sessionId });
  try {
    await logoutSession(req.auth!.sessionId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/auth/logout-all
export async function logoutAllController(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.logoutAllController", { userId: req.auth!.userId });
  try {
    await logoutAllSessions(req.auth!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/auth/config
export function authConfigController(_req: Request, res: Response) {
  traceLog("auth.controller.authConfigController");
  res.status(200).json({ providers: enabledAuthProviders });
}
