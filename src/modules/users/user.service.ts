import type { AuthProviderType, Role, User } from "../../db/types.js";
import { logger } from "../../lib/logger.js";
import {
  insertUserWithIdentity,
  selectIdentity,
  selectUserById,
  updateIdentityLastUsed,
  updateUserLastLogin,
  updateUserLastLoginAndAvatar,
  updateUserProfile,
  updateUserRole,
} from "./user.queries.js";

export async function findUserByIdentity(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<User | null> {
  const identity = await selectIdentity(provider, providerUserId);
  if (!identity) return null;
  return selectUserById(identity.userId);
}

export function createUserWithIdentity(input: {
  provider: AuthProviderType;
  providerUserId: string;
  email: string | null;
  phone: string | null;
  /** Google profile photo at signup time; pass null for non-Google providers. */
  avatarUrl: string | null;
}): Promise<User> {
  return insertUserWithIdentity({ ...input, now: new Date() });
}

export async function touchLastLogin(userId: number): Promise<User> {
  const user = await updateUserLastLogin(userId, new Date());
  if (!user) throw new Error(`touchLastLogin: user ${userId} not found`);
  return user;
}

/** Google sign-in only — see updateUserLastLoginAndAvatar. */
export async function touchLastLoginAndAvatar(
  userId: number,
  avatarUrl: string | null,
): Promise<User> {
  const user = await updateUserLastLoginAndAvatar(userId, new Date(), avatarUrl);
  if (!user) throw new Error(`touchLastLoginAndAvatar: user ${userId} not found`);
  return user;
}

export function touchIdentityLastUsed(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<void> {
  return updateIdentityLastUsed(provider, providerUserId, new Date());
}

/** True when required profile fields are missing. emergencyPhone is intentionally excluded. */
export function needsProfile(user: User): boolean {
  return !user.firstName || !user.lastName || !user.nickname;
}

export async function updateProfile(
  userId: number,
  input: Partial<Pick<User, "firstName" | "lastName" | "nickname" | "emergencyPhone">>,
): Promise<User> {
  const user = await updateUserProfile(userId, {
    firstName: input.firstName ?? undefined,
    lastName: input.lastName ?? undefined,
    nickname: input.nickname ?? undefined,
    emergencyPhone: input.emergencyPhone ?? undefined,
  });
  if (!user) throw new Error(`updateProfile: user ${userId} not found`);
  logger.info({ userId, fields: Object.keys(input) }, "profile updated");
  return user;
}

/**
 * ⚠ Used only by the TEMPORARY developer sign-in — DELETE BEFORE PRODUCTION along with it.
 * See README.md > Developer sign-in.
 */
export async function setUserRole(userId: number, role: Role): Promise<User> {
  const user = await updateUserRole(userId, role);
  if (!user) throw new Error(`setUserRole: user ${userId} not found`);
  logger.info({ userId, role }, "user role set");
  return user;
}

export function findUserById(userId: number): Promise<User | null> {
  return selectUserById(userId);
}
