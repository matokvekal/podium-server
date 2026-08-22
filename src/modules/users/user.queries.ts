// SQL for users and auth_identities. No SQL lives anywhere else in this module.
//
// `updated_at` is written explicitly on every write: the live database inherited it from
// Prisma as NOT NULL with no default, so the application has to maintain it.

import { execute, query, queryOne, withTransaction } from "../../db/pool.js";
import type { AuthIdentity, AuthProviderType, Role, User } from "../../db/types.js";

interface UserRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  emergency_phone: string | null;
  avatar_url: string | null;
  role: Role;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

interface AuthIdentityRow {
  id: number;
  user_id: number;
  provider: AuthProviderType;
  provider_user_id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    emergencyPhone: row.emergency_phone,
    avatarUrl: row.avatar_url,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function mapAuthIdentity(row: AuthIdentityRow): AuthIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function selectUserById(userId: number): Promise<User | null> {
  const row = await queryOne<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
  return row ? mapUser(row) : null;
}

export async function selectIdentity(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<AuthIdentity | null> {
  const row = await queryOne<AuthIdentityRow>(
    "SELECT * FROM auth_identities WHERE provider = $1 AND provider_user_id = $2",
    [provider, providerUserId],
  );
  return row ? mapAuthIdentity(row) : null;
}

/**
 * New account plus its first external identity — one transaction, never half of it.
 *
 * firstName/lastName/avatarUrl are whatever the provider already told us about this
 * person (Google's given_name, family_name and picture). They are only ever written
 * here, at creation: a later sign-in must not overwrite what the rider has since
 * edited. `nickname` is deliberately left NULL so needsProfile() still sends a new
 * rider to the profile-setup screen.
 */
export async function insertUserWithIdentity(input: {
  provider: AuthProviderType;
  providerUserId: string;
  email: string | null;
  phone: string | null;
<<<<<<< HEAD
  /** Google profile photo at signup time; null for non-Google providers. */
=======
  firstName: string | null;
  lastName: string | null;
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
  avatarUrl: string | null;
  now: Date;
}): Promise<User> {
  return withTransaction(async (tx) => {
    const userRow = await tx.queryOne<UserRow>(
<<<<<<< HEAD
      `INSERT INTO users (last_login_at, avatar_url, created_at, updated_at)
        VALUES ($1, $2, $3, $3)
        RETURNING *`,
      [input.now, input.avatarUrl, input.now],
=======
      `INSERT INTO users (first_name, last_name, avatar_url, last_login_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        RETURNING *`,
      [input.firstName, input.lastName, input.avatarUrl, input.now, input.now],
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
    );
    if (!userRow) throw new Error("insertUserWithIdentity returned no user row");

    await tx.query(
      `INSERT INTO auth_identities
        (user_id, provider, provider_user_id, email, phone, last_used_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
      [userRow.id, input.provider, input.providerUserId, input.email, input.phone, input.now],
    );

    return mapUser(userRow);
  });
}

export async function updateUserLastLogin(userId: number, at: Date): Promise<User | null> {
  const rows = await query<UserRow>(
    "UPDATE users SET last_login_at = $2, updated_at = $2 WHERE id = $1 RETURNING *",
    [userId, at],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Google sign-in only: touches last_login_at like updateUserLastLogin, and also refreshes
 * avatar_url from the Google ID token's current picture on every sign-in (a rider's Google
 * photo can change, so this is a full overwrite, not a COALESCE-guarded partial update).
 */
export async function updateUserLastLoginAndAvatar(
  userId: number,
  at: Date,
  avatarUrl: string | null,
): Promise<User | null> {
  const rows = await query<UserRow>(
    `UPDATE users
        SET last_login_at = $2,
            avatar_url = $3,
            updated_at = $2
      WHERE id = $1
      RETURNING *`,
    [userId, at, avatarUrl],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function updateIdentityLastUsed(
  provider: AuthProviderType,
  providerUserId: string,
  at: Date,
): Promise<void> {
  await execute(
    `UPDATE auth_identities SET last_used_at = $3, updated_at = $3
      WHERE provider = $1 AND provider_user_id = $2`,
    [provider, providerUserId, at],
  );
}

/**
 * Partial profile update. Every field is optional and none may be cleared, so COALESCE
 * keeps the stored value whenever the caller passed nothing — one static statement
 * instead of a SET clause assembled at runtime.
 */
export async function updateUserProfile(
  userId: number,
  input: {
    firstName?: string;
    lastName?: string;
    nickname?: string;
    emergencyPhone?: string;
  },
): Promise<User | null> {
  const rows = await query<UserRow>(
    `UPDATE users
        SET first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            nickname = COALESCE($4, nickname),
            emergency_phone = COALESCE($5, emergency_phone),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      userId,
      input.firstName ?? null,
      input.lastName ?? null,
      input.nickname ?? null,
      input.emergencyPhone ?? null,
    ],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * ⚠ Written for the TEMPORARY developer sign-in — DELETE BEFORE PRODUCTION along with it.
 * See README.md > Developer sign-in. There is deliberately no HTTP route that reaches this:
 * role is not something a user may change about themselves.
 */
export async function updateUserRole(userId: number, role: Role): Promise<User | null> {
  const rows = await query<UserRow>(
    "UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [userId, role],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}
