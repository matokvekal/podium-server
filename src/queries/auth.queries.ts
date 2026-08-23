// SQL for sessions — the refresh-token side of auth. No SQL lives anywhere else in
// this module. User rows are reached through the users module, never queried here.

import { execute, query, queryOne } from "../db/pool.js";
import type { Session } from "../db/types.js";

interface SessionRow {
  id: number;
  user_id: number;
  refresh_token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  device_info: string | null;
  ip_address: string | null;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    refreshTokenHash: row.refresh_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    deviceInfo: row.device_info,
    ipAddress: row.ip_address,
  };
}

export async function insertSession(input: {
  userId: number;
  refreshTokenHash: string;
  expiresAt: Date;
  lastUsedAt: Date;
  deviceInfo: string | null;
  ipAddress: string | null;
}): Promise<Session> {
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions
      (user_id, refresh_token_hash, expires_at, last_used_at, device_info, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
    [
      input.userId,
      input.refreshTokenHash,
      input.expiresAt,
      input.lastUsedAt,
      input.deviceInfo,
      input.ipAddress,
    ],
  );
  if (!row) throw new Error("insertSession returned no row");
  return mapSession(row);
}

/** Rotation writes the new hash onto the same row, so the old token stops matching anything. */
export async function updateSessionRotation(input: {
  sessionId: number;
  refreshTokenHash: string;
  expiresAt: Date;
  lastUsedAt: Date;
  deviceInfo: string | null;
  ipAddress: string | null;
}): Promise<void> {
  await execute(
    `UPDATE sessions
        SET refresh_token_hash = $2,
            expires_at = $3,
            last_used_at = $4,
            device_info = $5,
            ip_address = $6
      WHERE id = $1`,
    [
      input.sessionId,
      input.refreshTokenHash,
      input.expiresAt,
      input.lastUsedAt,
      input.deviceInfo,
      input.ipAddress,
    ],
  );
}

export async function selectSessionByRefreshTokenHash(hash: string): Promise<Session | null> {
  const row = await queryOne<SessionRow>("SELECT * FROM sessions WHERE refresh_token_hash = $1", [
    hash,
  ]);
  return row ? mapSession(row) : null;
}

export async function revokeSessionById(sessionId: number, at: Date): Promise<number> {
  return execute("UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
    sessionId,
    at,
  ]);
}

export async function revokeSessionsForUser(userId: number, at: Date): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE sessions SET revoked_at = $2
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [userId, at],
  );
  return rows.length;
}
