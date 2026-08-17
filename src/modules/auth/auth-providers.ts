import type { NextFunction, Request, Response } from "express";
import { type AuthProvider, env } from "../../config/env.js";
import { traceLog } from "../../lib/trace-log.js";

export type { AuthProvider };

export const enabledAuthProviders: AuthProvider[] = env.AUTH_PROVIDERS;

export function isAuthProviderEnabled(provider: AuthProvider): boolean {
  return enabledAuthProviders.includes(provider);
}

/** Route guard: rejects requests to a provider's endpoints when it isn't enabled. */
export function requireProviderEnabled(provider: AuthProvider) {
  return (_req: Request, res: Response, next: NextFunction) => {
    traceLog("middleware.requireProviderEnabled", { provider });
    if (!isAuthProviderEnabled(provider)) {
      return res.status(403).json({ error: "AUTH_PROVIDER_DISABLED" });
    }
    next();
  };
}

/**
 * ⚠ TEMPORARY DEVELOPMENT AID — DELETE BEFORE PRODUCTION. See README.md > Developer sign-in.
 *
 * Route guard for the passwordless developer login. `env.DEV_LOGIN_ENABLED` is already
 * forced to false in production (config/env.ts), and NODE_ENV is re-checked here so the
 * endpoint stays shut even if that ever regresses.
 */
export function requireDevLoginEnabled(_req: Request, res: Response, next: NextFunction) {
  traceLog("middleware.requireDevLoginEnabled", {
    devLoginEnabled: env.DEV_LOGIN_ENABLED,
    nodeEnv: env.NODE_ENV,
  });
  if (!env.DEV_LOGIN_ENABLED || env.NODE_ENV === "production") {
    return res.status(404).json({ error: "NOT_FOUND" });
  }
  next();
}
