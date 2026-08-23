import { env } from "../config/env.js";
import type { AuthProviderType, Role, User } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { verifyGoogleIdToken } from "../lib/google-auth.js";
import { signAccessToken } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import { requestOtp, verifyOtp } from "./otp.service.js";
import {
  createUserWithIdentity,
  findIdentity,
  findUserById,
  findUserByIdentity,
  type NewUserProfile,
  needsProfile,
  removeIdentity,
  setUserRole,
  touchIdentityLastUsed,
  touchLastLogin,
  updateProfile,
} from "./user.service.js";
import {
  findSessionByRefreshToken,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  type SessionContext,
} from "./session.service.js";
import { issueTokenPair, type TokenPair } from "./token.service.js";

function isDuplicateIdentityError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  const constraint =
    "constraint" in err ? (err as { constraint?: unknown }).constraint : undefined;
  return (
    code === "23505" &&
    constraint === "auth_identities_provider_provider_user_id_key"
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findUserByIdentityWithRetry(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<User | null> {
  // After a unique-violation race, the winner may not be committed yet on this connection.
  // Retry briefly so the loser request can continue as a normal returning login.
  const delaysMs = [0, 25, 50, 100];
  for (const delay of delaysMs) {
    if (delay > 0) await wait(delay);
    const user = await findUserByIdentity(provider, providerUserId);
    if (user) return user;
  }
  return null;
}

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
  newUserProfile?: NewUserProfile,
): Promise<User> {
  const identity = await findIdentity(provider, providerUserId);
  if (identity) {
    const existing = await findUserById(identity.userId);
    if (existing) {
      await touchIdentityLastUsed(provider, providerUserId);
      const user = await touchLastLogin(existing.id);
      logger.info({ userId: user.id, provider, isNewUser: false }, "user authenticated");
      return user;
    }

    // Corrupted row: identity exists but linked user no longer exists. Remove it so
    // sign-in can recreate a consistent user+identity pair.
    await removeIdentity(provider, providerUserId);
    logger.warn({ provider, providerUserId }, "removed dangling auth identity (missing user)");
  }

  const existing = await findUserByIdentity(provider, providerUserId);
  if (existing) {
    await touchIdentityLastUsed(provider, providerUserId);
    const user = await touchLastLogin(existing.id);
    logger.info({ userId: user.id, provider, isNewUser: false }, "user authenticated");
    return user;
  }
  let user: User;
  try {
    user = await createUserWithIdentity({
      provider,
      providerUserId,
      email,
      phone,
      profile: newUserProfile,
    });
  } catch (err) {
    // Two tabs (or repeated GIS callbacks) can race: both see "no identity", one inserts,
    // the other loses on the unique index. Treat that loser as a normal returning login.
    if (!isDuplicateIdentityError(err)) throw err;

    const recovered = await findUserByIdentityWithRetry(provider, providerUserId);
    if (!recovered) throw err;
    await touchIdentityLastUsed(provider, providerUserId);
    user = await touchLastLogin(recovered.id);
    logger.info({ userId: user.id, provider, isNewUser: false }, "user authenticated after identity race");
    return user;
  }
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

  // Everything below already came inside the token we just verified — no second call to
  // Google, no extra scope. `displayName` is read but intentionally not stored: it would
  // have to land in `nickname`, and that would satisfy needsProfile() and skip the
  // profile-setup screen. The rider picks their own nickname.
  const user = await resolveUser("GOOGLE", identity.subject, identity.email, null, {
    firstName: fitColumn(identity.firstName, 200),
    lastName: fitColumn(identity.lastName, 200),
    avatarUrl: fitColumn(identity.picture, 500),
  });
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
  const user = await resolveUser("SMS", phone, null, phone);
  return buildAuthResult(user, context);
}

/**
 * ⚠ TEMPORARY DEVELOPMENT AID — DELETE BEFORE PRODUCTION.
 * See README.md > Developer sign-in for the full removal checklist.
 *
 * Signs in as a fake user with no credential of any kind, and returns exactly the same
 * AuthResult as a real sign-in: a genuine access token and a genuine session row. That is
 * the point — the rest of the app then behaves identically to a real login, so nothing
 * downstream needs a "pretend" code path.
 *
 * The route is unreachable in production (see requireDevLoginEnabled); this second check
 * exists because the cost of it being wrong is an open door to every account.
 */
export async function authenticateAsDevUser(
  input: { role: Role; key: string },
  context: SessionContext,
): Promise<AuthResult> {
  if (!env.DEV_LOGIN_ENABLED || env.NODE_ENV === "production") {
    throw new ApiError(404, "Not found");
  }

  // EMAIL_PASSWORD with no password hash: it cannot collide with a real GOOGLE or SMS
  // identity, and it is inert — no other code path can authenticate this identity.
  const providerUserId = `dev-${input.key.toLowerCase()}`;
  let user = await resolveUser(
    "EMAIL_PASSWORD",
    providerUserId,
    `${providerUserId}@podium.local`,
    null,
  );

  // Fill the profile so the fake user lands in the app instead of the profile-setup screen.
  if (needsProfile(user)) {
    user = await updateProfile(user.id, {
      firstName: "Dev",
      lastName: input.key === "default" ? "User" : input.key,
      nickname: providerUserId,
    });
  }

  if (user.role !== input.role) {
    user = await setUserRole(user.id, input.role);
  }

  logger.warn(
    { userId: user.id, role: user.role, key: input.key },
    "DEV LOGIN USED — passwordless sign-in, development only",
  );
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
