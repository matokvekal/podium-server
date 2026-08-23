// SQL for otp_challenges. No SQL lives anywhere else in this module.

import { execute, query, queryOne } from "../db/pool.js";
import type { OtpChallenge } from "../db/types.js";

interface OtpChallengeRow {
  id: number;
  phone: string;
  code_hash: string;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  request_ip: string | null;
}

function mapOtpChallenge(row: OtpChallengeRow): OtpChallenge {
  return {
    id: row.id,
    phone: row.phone,
    codeHash: row.code_hash,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    requestIp: row.request_ip,
  };
}

export async function countChallengesSince(phone: string, since: Date): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM otp_challenges WHERE phone = $1 AND created_at >= $2",
    [phone, since],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Most recent challenge for this phone created at or after `since`, if any. */
export async function findLatestChallengeSince(
  phone: string,
  since: Date,
): Promise<OtpChallenge | null> {
  const row = await queryOne<OtpChallengeRow>(
    `SELECT * FROM otp_challenges
      WHERE phone = $1 AND created_at >= $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, since],
  );
  return row ? mapOtpChallenge(row) : null;
}

/**
 * The code hash is written by a follow-up update, not here: it is salted with the row's
 * own id, which only exists once the row does.
 */
export async function insertChallenge(input: {
  phone: string;
  expiresAt: Date;
  maxAttempts: number;
  requestIp: string | null;
}): Promise<OtpChallenge> {
  const row = await queryOne<OtpChallengeRow>(
    `INSERT INTO otp_challenges (phone, code_hash, expires_at, max_attempts, request_ip)
      VALUES ($1, '', $2, $3, $4)
      RETURNING *`,
    [input.phone, input.expiresAt, input.maxAttempts, input.requestIp],
  );
  if (!row) throw new Error("insertChallenge returned no row");
  return mapOtpChallenge(row);
}

export async function setChallengeCodeHash(id: number, codeHash: string): Promise<void> {
  await execute("UPDATE otp_challenges SET code_hash = $2 WHERE id = $1", [id, codeHash]);
}

export async function findChallengeById(id: number): Promise<OtpChallenge | null> {
  const row = await queryOne<OtpChallengeRow>("SELECT * FROM otp_challenges WHERE id = $1", [id]);
  return row ? mapOtpChallenge(row) : null;
}

export async function incrementChallengeAttempts(id: number): Promise<void> {
  await execute("UPDATE otp_challenges SET attempt_count = attempt_count + 1 WHERE id = $1", [id]);
}

export async function consumeChallenge(id: number, consumedAt: Date): Promise<void> {
  await execute("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [id, consumedAt]);
}
