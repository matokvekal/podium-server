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
  type NewUserProfile,
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

/**
 * The one place a provider identity becomes a Podium user. Keyed on
 * (provider, providerUserId) — for Google that is the immutable `sub`, never the email,
 * which can be reassigned.
 *
 * `newUserProfile` is applied ONLY on the branch that creates the row. An existing user
 * is never re-written from the provider: they may have edited their name since, and a
 * sign-in must not silently undo that.
 */
async function resolveUser(
  provider: AuthProviderType,
  providerUserId: string,
  email: string | null,
  phone: string | null,
<<<<<<< HEAD
  /** Google's current profile photo. Only ever non-null for provider "GOOGLE" — SMS/dev-login
   *  callers pass null and avatar_url is left untouched for them. */
  avatarUrl: string | null,
=======
  newUserProfile?: NewUserProfile,
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
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
<<<<<<< HEAD
  const user = await createUserWithIdentity({ provider, providerUserId, email, phone, avatarUrl });
=======
  const user = await createUserWithIdentity({
    provider,
    providerUserId,
    email,
    phone,
    profile: newUserProfile,
  });
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
  logger.info({ userId: user.id, provider, isNewUser: true }, "user authenticated");
  return user;
}

/**
 * Column widths are VARCHAR(200) for the names and VARCHAR(500) for avatar_url. Google
 * has no documented ceiling on any of them, and an over-long value would make the INSERT
 * throw — which would fail the whole sign-in. Truncating is the lesser evil; an empty or
 * blank value becomes NULL so it does not look like a filled-in profile field.
 */
function fitColumn(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
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

<<<<<<< HEAD
  const user = await resolveUser(
    "GOOGLE",
    identity.subject,
    identity.email,
    null,
    identity.picture ?? null,
  );
=======
  // Everything below already came inside the token we just verified — no second call to
  // Google, no extra scope. `displayName` is read but intentionally not stored: it would
  // have to land in `nickname`, and that would satisfy needsProfile() and skip the
  // profile-setup screen. The rider picks their own nickname.
  const user = await resolveUser("GOOGLE", identity.subject, identity.email, null, {
    firstName: fitColumn(identity.firstName, 200),
    lastName: fitColumn(identity.lastName, 200),
    avatarUrl: fitColumn(identity.picture, 500),
  });
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
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
