import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../../lib/trace-log.js";
import {
  googleAuthSchema,
  refreshSchema,
  smsRequestSchema,
  smsVerifySchema,
} from "./auth.schemas.js";
import {
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
  traceLog("auth.controller.google");
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
    traceLog("auth.controller.smsRequest", { phone });
    const result = await requestSmsOtp(phone, req.ip ?? null);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function smsVerify(req: Request, res: Response, next: NextFunction) {
  try {
    const { challengeId, code } = smsVerifySchema.parse(req.body);
    traceLog("auth.controller.smsVerify", { challengeId });
    const result = await verifySmsOtp(challengeId, code, sessionContext(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.refresh");
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await refreshTokens(refreshToken, sessionContext(req));
    res.status(200).json(tokens);
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.logout", { sessionId: req.auth!.sessionId });
  try {
    await logoutSession(req.auth!.sessionId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction) {
  traceLog("auth.controller.logoutAll", { userId: req.auth!.userId });
  try {
    await logoutAllSessions(req.auth!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export function config(_req: Request, res: Response) {
  traceLog("auth.controller.config");
  res.status(200).json({ providers: enabledAuthProviders });
}
