import type { AuthProviderType, Role, User } from "../db/types.js";
import { logger } from "../lib/logger.js";
import {
  deleteIdentity,
  insertUserWithIdentity,
  selectIdentity,
  selectUserById,
  updateIdentityLastUsed,
  updateUserLastLogin,
  updateUserProfile,
  updateUserRole,
} from "../queries/user.queries.js";

/**
 * Profile fields an identity provider can hand us at sign-up. Every one is optional:
 * Google only guarantees `sub` and `email`, the rest depend on the account.
 */
export interface NewUserProfile {
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
}

export async function findUserByIdentity(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<User | null> {
  const identity = await selectIdentity(provider, providerUserId);
  if (!identity) return null;
  return selectUserById(identity.userId);
}

export function findIdentity(
  provider: AuthProviderType,
  providerUserId: string,
) {
  return selectIdentity(provider, providerUserId);
}

export function removeIdentity(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<number> {
  return deleteIdentity(provider, providerUserId);
}

/**
 * `profile` is what the identity provider already knew about this person — it is applied
 * once, here, and never on a later sign-in. Providers that carry no profile (SMS) pass
 * nothing and the columns stay NULL.
 */
export function createUserWithIdentity(input: {
  provider: AuthProviderType;
  providerUserId: string;
  email: string | null;
  phone: string | null;
  profile?: NewUserProfile;
}): Promise<User> {
  return insertUserWithIdentity({
    provider: input.provider,
    providerUserId: input.providerUserId,
    email: input.email,
    phone: input.phone,
    firstName: input.profile?.firstName ?? null,
    lastName: input.profile?.lastName ?? null,
    avatarUrl: input.profile?.avatarUrl ?? null,
    now: new Date(),
  });
}

export async function touchLastLogin(userId: number): Promise<User> {
  const user = await updateUserLastLogin(userId, new Date());
  if (!user) throw new Error(`touchLastLogin: user ${userId} not found`);
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
