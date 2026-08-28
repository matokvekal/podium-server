// SQL for user_entitlements — the authoritative per-user entitlement/limits model. No SQL
// lives anywhere else for this table.
//
// A missing row means "this user has no override": the server resolves their limits from
// their plan, which for a free user is DEFAULT_PLAN_LIMITS. A row is an explicit set of
// values that wins per field (see resolveEffectiveLimits in config/plan-limits.ts).

import { resolveEffectiveLimits, type UserEntitlementRow } from "../config/plan-limits.js";
import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";

export { resolveEffectiveLimits };

interface UserEntitlementsDbRow {
  user_id: number;
  max_events_per_week: number;
  max_participants_per_event: number;
  max_groups_per_event: number;
  note: string | null;
}

/**
 * This user's entitlement row mapped to camelCase, or null when they have none.
 *
 * A missing `user_entitlements` table is not an error. The code may ship before sql/020 is
 * applied — until then every user resolves to their plan limits, exactly as before. Same
 * fallback selectLiveGrants uses for the same reason (authz/entitlements.ts).
 */
export async function selectUserEntitlements(userId: number): Promise<{
  maxEventsPerWeek: number;
  maxParticipantsPerEvent: number;
  maxGroupsPerEvent: number;
} | null> {
  try {
    const rows = await query<UserEntitlementsDbRow>(
      `SELECT user_id, max_events_per_week, max_participants_per_event, max_groups_per_event, note
         FROM user_entitlements
        WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      maxEventsPerWeek: row.max_events_per_week,
      maxParticipantsPerEvent: row.max_participants_per_event,
      maxGroupsPerEvent: row.max_groups_per_event,
    };
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "42P01") {
      logger.warn({ userId }, "user_entitlements table missing; falling back to plan limits");
      return null;
    }
    throw err;
  }
}

/**
 * Set or adjust one user's entitlement row. Every limit is optional: a field left out keeps
 * whatever is already stored (or, on a first insert, the column default — 3 / 50 / 2, the
 * same numbers as DEFAULT_PLAN_LIMITS and sql/020-user-entitlements.sql).
 *
 * There is deliberately no HTTP route to this. It is the seam a future billing or support
 * tool writes through, and until that exists it is called from psql or a script.
 */
export async function upsertUserEntitlements(
  userId: number,
  limits: {
    maxEventsPerWeek?: number;
    maxParticipantsPerEvent?: number;
    maxGroupsPerEvent?: number;
    note?: string | null;
  },
): Promise<void> {
  await query(
    `INSERT INTO user_entitlements
        (user_id, max_events_per_week, max_participants_per_event, max_groups_per_event, note)
      VALUES ($1, COALESCE($2, 3), COALESCE($3, 50), COALESCE($4, 2), $5)
      ON CONFLICT (user_id) DO UPDATE
         SET max_events_per_week        = COALESCE($2, user_entitlements.max_events_per_week),
             max_participants_per_event = COALESCE($3, user_entitlements.max_participants_per_event),
             max_groups_per_event       = COALESCE($4, user_entitlements.max_groups_per_event),
             note                       = COALESCE($5, user_entitlements.note),
             updated_at                 = NOW()`,
    [
      userId,
      limits.maxEventsPerWeek ?? null,
      limits.maxParticipantsPerEvent ?? null,
      limits.maxGroupsPerEvent ?? null,
      limits.note ?? null,
    ],
  );
  logger.info({ userId }, "user entitlements updated");
}

export type { UserEntitlementRow };
