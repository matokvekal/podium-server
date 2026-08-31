// SQL for user_limits — the single runtime source of truth for what a user may do. No SQL for
// this table lives anywhere else.
//
// Every row carries REAL VALUES. There is no NULL-means-inherit state and no fallback: a user
// without a row is a data-integrity fault, and selectUserLimitsOrThrow says so loudly rather
// than quietly handing back the free tier. Rows are created in the same transaction as the
// user (insertUserLimitsTx) and backfilled for pre-existing users by sql/019.

import { getDefaultUserLimits, type EffectiveLimits } from "../config/plan-limits.js";
import { query, type Transaction } from "../db/pool.js";
import { logger } from "../lib/logger.js";

/** The row exactly as Postgres returns it. Columns are NOT NULL, so the numbers are real. */
export interface UserLimitsRow {
  user_id: number;
  events_per_week: number;
  participants_per_event: number;
  groups_per_event: number;
  teams_owned: number;
  note: string | null;
}

/**
 * Raised when a user has no user_limits row.
 *
 * This is deliberately fatal to the request. The row is written in the same transaction as the
 * user, so its absence means either the sql/019 backfill has not been run or something deleted
 * it — both are problems an operator must see. Silently substituting config defaults here is
 * precisely the behaviour this design removes: it hid a completely unapplied migration behind
 * a plausible-looking "3 rides per week" for as long as it went unnoticed.
 */
export class UserLimitsNotFoundError extends Error {
  readonly userId: number;

  constructor(userId: number) {
    super(
      `No user_limits row for user ${userId}. Every user must have one — it is written with ` +
        `the user (insertUserLimitsTx) and backfilled by sql/019-user-limits-backfill.sql.`,
    );
    this.name = "UserLimitsNotFoundError";
    this.userId = userId;
  }
}

/** The DB spells it teams_owned; the rest of the code says teamsPerOwner. Bridged only here. */
export function mapUserLimitsRow(row: UserLimitsRow): EffectiveLimits {
  return {
    maxEventsPerWeek: row.events_per_week,
    maxParticipantsPerEvent: row.participants_per_event,
    maxGroupsPerEvent: row.groups_per_event,
    maxTeamsPerOwner: row.teams_owned,
  };
}

const SELECT_COLUMNS = `user_id, events_per_week, participants_per_event, groups_per_event,
                        teams_owned, note`;

/** This user's row, or null when they have none. Prefer selectUserLimitsOrThrow. */
export async function selectUserLimits(userId: number): Promise<UserLimitsRow | null> {
  const rows = await query<UserLimitsRow>(
    `SELECT ${SELECT_COLUMNS} FROM user_limits WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * This user's limits, or a thrown UserLimitsNotFoundError.
 *
 * Note there is no try/catch around the query. A missing `user_limits` TABLE now surfaces as
 * the raw Postgres 42P01 and takes the request down with it, on purpose — the old code caught
 * that code and returned null, which is how an unapplied migration stayed invisible.
 */
export async function selectUserLimitsOrThrow(userId: number): Promise<EffectiveLimits> {
  const row = await selectUserLimits(userId);
  if (!row) throw new UserLimitsNotFoundError(userId);
  return mapUserLimitsRow(row);
}

/**
 * Create this user's row, inside the caller's transaction.
 *
 * ON CONFLICT DO NOTHING rather than DO UPDATE: this runs at signup, and if a row somehow
 * already exists it is a real one whose values must not be stamped back down to the defaults.
 */
export async function insertUserLimitsTx(
  tx: Transaction,
  userId: number,
  limits: EffectiveLimits = getDefaultUserLimits(),
  note = "created with user",
): Promise<void> {
  await tx.query(
    `INSERT INTO user_limits
        (user_id, events_per_week, participants_per_event, groups_per_event, teams_owned, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO NOTHING`,
    [
      userId,
      limits.maxEventsPerWeek,
      limits.maxParticipantsPerEvent,
      limits.maxGroupsPerEvent,
      limits.maxTeamsPerOwner,
      note,
    ],
  );
}

/**
 * Overwrite a user's limits with a plan's numbers. Called when a grant changes which plan they
 * are on — that is what keeps user_limits authoritative without the request path ever looking
 * at entitlement_grants.
 *
 * Takes a Transaction so the grant and the limits it implies commit together; a grant that
 * wrote without its limits would leave the user paying for a tier the runtime cannot see.
 */
export async function applyPlanLimitsTx(
  tx: Transaction,
  userId: number,
  limits: EffectiveLimits,
  note: string,
): Promise<void> {
  await tx.query(
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
      limits.maxEventsPerWeek,
      limits.maxParticipantsPerEvent,
      limits.maxGroupsPerEvent,
      limits.maxTeamsPerOwner,
      note,
    ],
  );
  logger.info({ userId, limits, note }, "user limits set from plan");
}

/**
 * Set one user's limits by hand — the support path. Every field is required, because a row
 * always holds real values; there is no "leave this one to the plan" any more.
 *
 * There is deliberately no HTTP route to this yet. It is the seam a future billing or support
 * tool writes through, and until that exists it is called from psql or a script.
 */
export async function upsertUserLimits(
  userId: number,
  limits: EffectiveLimits,
  note: string | null = null,
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
      limits.maxEventsPerWeek,
      limits.maxParticipantsPerEvent,
      limits.maxGroupsPerEvent,
      limits.maxTeamsPerOwner,
      note,
    ],
  );
  logger.info({ userId }, "user limits updated");
}
