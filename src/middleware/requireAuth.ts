import type { NextFunction, Request, Response } from "express";
import type { Role } from "../db/types.js";
import { InvalidTokenError, verifyAccessToken } from "../lib/jwt.js";
import { traceLog } from "../lib/trace-log.js";

export interface AuthContext {
  userId: number;
  role: Role;
  sessionId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/**
 * Verifies a Commissaire access token only (signature + expiry, no I/O). Google/SMS
 * verification never happens here — those only run at the provider auth endpoints.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  traceLog("middleware.requireAuth", { method: req.method, path: req.path });
  const token = extractBearerToken(req.header("authorization"));
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  try {
    const claims = await verifyAccessToken(token);
    const userId = Number(claims.sub);
    const sessionId = Number(claims.sid);
    if (!Number.isInteger(userId) || !Number.isInteger(sessionId)) {
      throw new InvalidTokenError("Malformed access token payload");
    }
    req.auth = { userId, role: claims.role, sessionId };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
  }
}

/**
 * Same verification as requireAuth, but a missing, malformed or expired token is not an
 * error — req.auth is simply left unset and the route decides what an anonymous viewer may
 * see. For routes where a signed-in viewer sees more (their own private event) but a
 * stranger can still see something (a public one).
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  traceLog("middleware.optionalAuth", { method: req.method, path: req.path });
  const token = extractBearerToken(req.header("authorization"));
  if (!token) return next();

  try {
    const claims = await verifyAccessToken(token);
    const userId = Number(claims.sub);
    const sessionId = Number(claims.sid);
    if (!Number.isInteger(userId) || !Number.isInteger(sessionId)) {
      throw new InvalidTokenError("Malformed access token payload");
    }
    req.auth = { userId, role: claims.role, sessionId };
  } catch {
    // Treat as anonymous rather than rejecting — the token might just be stale.
  }
  next();
}
