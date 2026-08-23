import type { NextFunction, Request, Response } from "express";
import { type AuthProvider, env } from "./env.js";
import { traceLog } from "../lib/trace-log.js";

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
