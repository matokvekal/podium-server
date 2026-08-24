// SQL for users and auth_identities. No SQL lives anywhere else in this module.
//
// `updated_at` is written explicitly on every write: the live database inherited it from
// Prisma as NOT NULL with no default, so the application has to maintain it.

import type { UserImageKind, UserImageSource } from "../config/user-images.js";
import { execute, query, queryOne, withTransaction } from "../db/pool.js";
import type { AuthIdentity, AuthProviderType, Role, User } from "../db/types.js";

interface UserRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  emergency_phone: string | null;
  avatar_url: string | null;
  avatar_type: string | null;
  avatar_value: string | null;
  cover_type: string | null;
  cover_value: string | null;
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
    // Nullish-coalesced, not read straight through: a database that has not had
    // sql/017-user-avatar-cover.sql applied yet returns rows without these keys at all, and
    // every existing endpoint has to keep working on such a database.
    avatarType: row.avatar_type ?? null,
    avatarValue: row.avatar_value ?? null,
    coverType: row.cover_type ?? null,
    coverValue: row.cover_value ?? null,
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

export async function deleteIdentity(
  provider: AuthProviderType,
  providerUserId: string,
): Promise<number> {
  return execute("DELETE FROM auth_identities WHERE provider = $1 AND provider_user_id = $2", [
    provider,
    providerUserId,
  ]);
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
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  now: Date;
}): Promise<User> {
  return withTransaction(async (tx) => {
    const userRow = await tx.queryOne<UserRow>(
      `INSERT INTO users (first_name, last_name, avatar_url, last_login_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        RETURNING *`,
      [input.firstName, input.lastName, input.avatarUrl, input.now, input.now],
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
 * Set or clear one of a user's two images.
 *
 * The column name cannot be a bind parameter, so there are two statements rather than one
 * assembled at runtime — `kind` is a closed union, never a caller's string, and this way
 * every SQL string in the file is still a literal you can read.
 *
 * Passing (null, null) is the reset: it clears the choice and the API falls back to
 * users.avatar_url, which this never touches.
 */
export async function updateUserImage(
  userId: number,
  kind: UserImageKind,
  type: UserImageSource | null,
  value: string | null,
): Promise<User | null> {
  const sql =
    kind === "avatar"
      ? `UPDATE users SET avatar_type = $2, avatar_value = $3, updated_at = NOW()
          WHERE id = $1 RETURNING *`
      : `UPDATE users SET cover_type = $2, cover_value = $3, updated_at = NOW()
          WHERE id = $1 RETURNING *`;

  const rows = await query<UserRow>(sql, [userId, type, value]);
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Every upload reference the database currently points at, for the orphan sweeper in
 * scripts/cleanup-user-uploads.mjs. Preset rows are excluded on purpose: a preset value is a
 * registry id, not a file this user owns, and preset art must never be swept.
 */
export async function selectAllUploadRefs(): Promise<{ userId: number; ref: string }[]> {
  const rows = await query<{ user_id: number; ref: string }>(
    `SELECT id AS user_id, avatar_value AS ref FROM users
       WHERE avatar_type = 'upload' AND avatar_value IS NOT NULL
     UNION ALL
     SELECT id AS user_id, cover_value AS ref FROM users
       WHERE cover_type = 'upload' AND cover_value IS NOT NULL`,
  );
  return rows.map((row) => ({ userId: row.user_id, ref: row.ref }));
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
