import type { AuthProviderType, User } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { verifyGoogleIdToken } from "../../lib/google-auth.js";
import { signAccessToken } from "../../lib/jwt.js";
import { logger } from "../../lib/logger.js";
import { requestOtp, verifyOtp } from "../sms/otp.service.js";
import {
  createUserWithIdentity,
  findUserById,
  findUserByIdentity,
  needsProfile,
  touchIdentityLastUsed,
  touchLastLogin,
  touchLastLoginAndAvatar,
} from "../users/user.service.js";
import {
  findSessionByRefreshToken,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  type SessionContext,
} from "./session.service.js";
import { issueTokenPair, type TokenPair } from "./token.service.js";

export interface AuthResult {
  user: { id: number; role: User["role"] };
  accessToken: string;
  refreshToken: string;
  requiresProfile: boolean;
}

async function resolveUser(
  provider: AuthProviderType,
  providerUserId: string,
  email: string | null,
  phone: string | null,
  /** Google's current profile photo. Only ever non-null for provider "GOOGLE" — SMS/dev-login
   *  callers pass null and avatar_url is left untouched for them. */
  avatarUrl: string | null,
): Promise<User> {
  const existing = await findUserByIdentity(provider, providerUserId);
  if (existing) {
    await touchIdentityLastUsed(provider, providerUserId);
    // Google photos change over time, so re-sign-in refreshes avatar_url every time. Other
    // providers keep using the plain last-login touch, which never writes avatar_url.
    const user =
      provider === "GOOGLE"
        ? await touchLastLoginAndAvatar(existing.id, avatarUrl)
        : await touchLastLogin(existing.id);
    logger.info({ userId: user.id, provider, isNewUser: false }, "user authenticated");
    return user;
  }
  const user = await createUserWithIdentity({ provider, providerUserId, email, phone, avatarUrl });
  logger.info({ userId: user.id, provider, isNewUser: true }, "user authenticated");
  return user;
}

async function buildAuthResult(user: User, context: SessionContext): Promise<AuthResult> {
  if (!user.isActive) {
    throw new ApiError(403, "This account has been disabled");
  }
  const { accessToken, refreshToken } = await issueTokenPair(user, context);
  return {
    user: { id: user.id, role: user.role },
    accessToken,
    refreshToken,
    requiresProfile: needsProfile(user),
  };
}

export async function authenticateWithGoogle(
  idToken: string,
  context: SessionContext,
): Promise<AuthResult> {
  let identity: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (err) {
    logger.warn({ err }, "authenticateWithGoogle: token verification failed");
    throw new ApiError(401, "Invalid or expired Google ID token");
  }
  if (!identity.emailVerified) {
    logger.warn({ email: identity.email }, "authenticateWithGoogle: email not verified");
    throw new ApiError(401, "Google account email is not verified");
  }

  const user = await resolveUser(
    "GOOGLE",
    identity.subject,
    identity.email,
    null,
    identity.picture ?? null,
  );
  return buildAuthResult(user, context);
}

export async function requestSmsOtp(
  phone: string,
  requestIp: string | null,
): Promise<{ challengeId: number }> {
  return requestOtp(phone, requestIp);
}

export async function verifySmsOtp(
  challengeId: number,
  code: string,
  context: SessionContext,
): Promise<AuthResult> {
  const phone = await verifyOtp(challengeId, code);
  const user = await resolveUser("SMS", phone, null, phone, null);
  return buildAuthResult(user, context);
}

export async function refreshTokens(
  refreshToken: string,
  context: SessionContext,
): Promise<TokenPair> {
  const session = await findSessionByRefreshToken(refreshToken);
  if (!session) {
    // Covers unknown, revoked, expired, and already-rotated-away tokens alike — the old hash no
    // longer matches any row once a session has rotated, so reuse of a stale token ends up here.
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  const user = await findUserById(session.userId);
  if (!user) {
    // The session outlived its user row — treat it exactly like an unknown token.
    await revokeSession(session.id);
    throw new ApiError(401, "Invalid or expired refresh token");
  }
  if (!user.isActive) {
    await revokeSession(session.id);
    throw new ApiError(403, "This account has been disabled");
  }

  const newRefreshToken = await rotateSession(session.id, context);
  const accessToken = await signAccessToken({
    sub: String(user.id),
    role: user.role,
    sid: String(session.id),
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(sessionId: number): Promise<void> {
  await revokeSession(sessionId);
}

export async function logoutAll(userId: number): Promise<void> {
  await revokeAllSessions(userId);
}
