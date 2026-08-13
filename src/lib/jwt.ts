import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import type { Role } from "../db/types.js";

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  sid: string;
}

export class InvalidTokenError extends Error {
  constructor(message = "Invalid or expired token") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_EXPIRES_IN)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, accessSecret));
  } catch {
    throw new InvalidTokenError();
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.role !== "string"
  ) {
    throw new InvalidTokenError("Malformed access token payload");
  }

  return { sub: payload.sub, role: payload.role as Role, sid: payload.sid };
}
