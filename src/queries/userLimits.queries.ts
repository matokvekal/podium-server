// SQL for user_limits — the per-user limit override. No SQL lives anywhere else in this module.
//
// A missing row and a row of all NULLs mean the same thing: this user has no override and
// inherits their plan's limits. Callers therefore never need to distinguish the two.

import type { UserLimitDbRow } from "../config/plan-limits.js";
import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";

interface UserLimitsRow {
  user_id: number;
  events_per_week: number | null;
  participants_per_event: number | null;
  groups_per_event: number | null;
  teams_owned: number | null;
  note: string | null;
}

/**
 * This user's override, or null when they have none.
 *
 * A missing `user_limits` table is not an error. The code ships before sql/018 is applied —
 * that is the deployment order the whole feature is designed around — and until then every
 * user simply resolves to their plan limits, exactly as before. Same fallback the grants
 * reader uses for the same reason (authz/entitlements.ts selectLiveGrants).
 */
export async function selectUserLimits(userId: number): Promise<UserLimitDbRow> {
  try {
    const rows = await query<UserLimitsRow>(
      `SELECT user_id, events_per_week, participants_per_event, groups_per_event, teams_owned, note
         FROM user_limits
        WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "42P01") {
      logger.warn({ userId }, "user_limits table missing; falling back to plan limits");
      return null;
    }
    throw err;
  }
}

/**
 * Set or clear one user's override. Every field is optional; passing `null` for one CLEARS
 * that override back to "inherit from the plan", which is why this cannot use the COALESCE
 * pattern updateUserProfile uses — there, null means "unchanged"; here it is a real value.
 *
 * There is deliberately no HTTP route to this yet. It is the seam a future billing or support
 * tool writes through, and until that exists it is called from psql or a script.
 */
export async function upsertUserLimits(
  userId: number,
  limits: {
    eventsPerWeek?: number | null;
    participantsPerEvent?: number | null;
    groupsPerEvent?: number | null;
    teamsOwned?: number | null;
    note?: string | null;
  },
): Promise<void> {
  await query(
    `INSERT INTO user_limits
        (user_id, events_per_week, participants_per_event, groups_per_event, teams_owned, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO UPDATE
         SET events_per_week        = EXCLUDED.events_per_week,
             participants_per_event = EXCLUDED.participants_per_event,
             groups_per_event       = EXCLUDED.groups_per_event,
             teams_owned            = EXCLUDED.teams_owned,
             note                   = EXCLUDED.note,
             updated_at             = NOW()`,
    [
      userId,
      limits.eventsPerWeek ?? null,
      limits.participantsPerEvent ?? null,
      limits.groupsPerEvent ?? null,
      limits.teamsOwned ?? null,
      limits.note ?? null,
    ],
  );
  logger.info({ userId }, "user limits updated");
}
