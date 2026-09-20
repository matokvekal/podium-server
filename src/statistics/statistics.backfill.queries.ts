// Statistics history backfill — the SQL the one-time backfill (statistics.backfill.ts) needs that
// the live paths do not: who to process, why other rides were skipped, and a bulk write.
//
// The RIDE FACTS themselves are deliberately NOT read here. The backfill uses the live
// selectFinishedRideFactsForUser, so "what counts as a ride" and "how a ride's km/climb/hours are
// derived" live in exactly one place. The breakdown below only EXPLAINS the skips, and reuses the
// live check-in predicate (checkinRuleSql); the backfill cross-checks its "counted" total against
// the facts it really read, so any drift between the two shows up as a warning in the report.

import { query, type Transaction } from "../db/pool.js";
import {
  type CachedRiderStats,
  checkinRuleSql,
  type PeriodType,
  type RiderStatsTotals,
} from "./statistics.queries.js";

export interface BackfillCandidate {
  userId: number;
  country: string | null;
  weightKg: number | null;
  isActive: boolean;
  /** users.stats_backfill_excluded (sql/044) — the backfill leaves this account alone. */
  excluded: boolean;
}

export interface CandidateFilter {
  /** Resume point: only accounts with id > this. */
  afterUserId?: number;
  /** Only these accounts (still subject to exclusion). */
  userIds?: readonly number[];
  /** At most this many accounts. */
  limit?: number;
}

/**
 * Every account with at least one confirmed, not-left participation on a finished ride — the
 * riders the backfill could have something to say about — in id order (so a run can be resumed
 * from the last id it reported). Whether a ride then COUNTS is decided later, by the live facts
 * query; this is only the "worth looking at" list. Excluded accounts are returned (flagged) so
 * the report can name them; the backfill never processes them.
 */
export async function selectBackfillCandidates(
  filter: CandidateFilter = {},
): Promise<BackfillCandidate[]> {
  const rows = await query<{
    id: number;
    country: string | null;
    weight_kg: string | number | null;
    is_active: boolean;
    stats_backfill_excluded: boolean;
  }>(
    `SELECT u.id, u.country, u.weight_kg, u.is_active, u.stats_backfill_excluded
       FROM users u
      WHERE u.id > $1
        AND ($2::bigint[] IS NULL OR u.id = ANY($2::bigint[]))
        AND EXISTS (
          SELECT 1
            FROM event_participants ep
            JOIN events e ON e.id = ep.event_id AND e.status = 'finished'
           WHERE ep.user_id = u.id
             AND ep.registration_status IN ('registered', 'approved')
             AND ep.left_at IS NULL
             AND e.finished_at IS NOT NULL)
      ORDER BY u.id
      LIMIT $3`,
    [filter.afterUserId ?? 0, filter.userIds ? [...filter.userIds] : null, filter.limit ?? null],
  );
  return rows.map((row) => ({
    userId: row.id,
    country: row.country,
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    isActive: row.is_active,
    excluded: row.stats_backfill_excluded,
  }));
}

export interface ParticipationBreakdownRow {
  /** 'counted' or the one reason the participation is not counted. */
  reason: string;
  participations: number;
}

/**
 * Every participation row, bucketed by the FIRST reason it does not count (or 'counted'). The
 * order of the CASE arms is the priority: account-level reasons, then the ride, then the
 * participation itself. 'counted' is exactly what selectFinishedRideFactsForUser returns for the
 * same accounts (with the same `requireCheckinFrom`).
 */
export async function selectParticipationBreakdown(
  filter: Pick<CandidateFilter, "afterUserId" | "userIds">,
  options: {
    requireCheckinFrom: Date | null;
    autoFinishGraceHours: number;
    autoFinishStatuses: readonly string[];
  },
): Promise<ParticipationBreakdownRow[]> {
  const notCheckedIn = options.requireCheckinFrom ? `NOT ${checkinRuleSql(5)}` : "FALSE";
  const noAccountFilter = (filter.afterUserId ?? 0) === 0 && !filter.userIds;
  const rows = await query<{ reason: string; participations: number }>(
    `SELECT reason, COUNT(*)::int AS participations
       FROM (
         SELECT CASE
             WHEN ep.user_id IS NULL THEN 'guest_participant_no_account'
             WHEN u.id IS NULL THEN 'account_missing'
             WHEN u.stats_backfill_excluded THEN 'account_excluded'
             WHEN e.status <> 'finished'
                  AND e.status = ANY($3::text[])
                  AND COALESCE(e.ends_at, e.starts_at) < NOW() - make_interval(hours => $4)
               THEN 'ride_past_due_awaiting_auto_finish'
             WHEN e.status <> 'finished' THEN 'ride_not_finished:' || e.status
             WHEN e.finished_at IS NULL THEN 'ride_finished_without_finished_at'
             WHEN ep.registration_status NOT IN ('registered', 'approved')
               THEN 'registration_' || ep.registration_status
             WHEN ep.left_at IS NOT NULL THEN 'rider_left_the_ride'
             WHEN ${notCheckedIn} THEN 'no_check_in_on_ride_after_rollout'
             ELSE 'counted'
           END AS reason
           FROM event_participants ep
           JOIN events e ON e.id = ep.event_id
           LEFT JOIN users u ON u.id = ep.user_id
          WHERE (ep.user_id > $1 AND ($2::bigint[] IS NULL OR ep.user_id = ANY($2::bigint[])))
             OR (ep.user_id IS NULL AND ${noAccountFilter ? "TRUE" : "FALSE"})
       ) classified
      GROUP BY reason
      ORDER BY participations DESC, reason`,
    [
      filter.afterUserId ?? 0,
      filter.userIds ? [...filter.userIds] : null,
      [...options.autoFinishStatuses],
      options.autoFinishGraceHours,
      ...(options.requireCheckinFrom ? [options.requireCheckinFrom] : []),
    ],
  );
  return rows;
}

/** Every rider_stats_cache row this account has (lifetime = year 0), keyed by year. */
export async function selectStatsCacheRows(userId: number): Promise<Map<number, CachedRiderStats>> {
  const rows = await query<{
    year: number;
    rides_count: number;
    total_km: string | number;
    total_climb_m: string | number;
    total_hours: string | number;
    total_calories: number | null;
    computed_at: Date;
  }>(
    `SELECT year, rides_count, total_km, total_climb_m, total_hours, total_calories, computed_at
       FROM rider_stats_cache WHERE user_id = $1`,
    [userId],
  );
  return new Map(
    rows.map((row) => [
      row.year,
      {
        ridesCount: row.rides_count,
        totalKm: Number(row.total_km),
        totalClimbM: Number(row.total_climb_m),
        totalHours: Number(row.total_hours),
        totalCalories: row.total_calories,
        computedAt: row.computed_at,
      },
    ]),
  );
}

/**
 * Upserts many period rows for one rider in one statement — same columns and same ON CONFLICT as
 * the live upsertPeriodStats, so a backfilled row is indistinguishable from a live-written one.
 * The primary key (user_id, period_type, period) is what makes a re-run an overwrite, never a
 * duplicate.
 */
export async function upsertPeriodStatsBatch(
  userId: number,
  periodType: PeriodType,
  rows: readonly { period: string; totals: RiderStatsTotals }[],
  tx: Transaction,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.query(
    `INSERT INTO rider_period_stats
        (user_id, period_type, period, rides_count, total_km, total_climb_m, total_hours,
         total_calories, computed_at)
      SELECT $1::bigint, $2::varchar, p.period, p.rides, p.km, p.climb, p.hours, p.calories, NOW()
        FROM unnest($3::text[], $4::int[], $5::float8[], $6::float8[], $7::float8[], $8::int[])
             AS p(period, rides, km, climb, hours, calories)
      ON CONFLICT (user_id, period_type, period) DO UPDATE
         SET rides_count    = EXCLUDED.rides_count,
             total_km       = EXCLUDED.total_km,
             total_climb_m  = EXCLUDED.total_climb_m,
             total_hours    = EXCLUDED.total_hours,
             total_calories = EXCLUDED.total_calories,
             computed_at    = NOW()`,
    [
      userId,
      periodType,
      rows.map((r) => r.period),
      rows.map((r) => r.totals.ridesCount),
      rows.map((r) => r.totals.totalKm),
      rows.map((r) => r.totals.totalClimbM),
      rows.map((r) => r.totals.totalHours),
      rows.map((r) => r.totals.totalCalories),
    ],
  );
}

/** Migrations the backfill cannot run without, checked up front so a missing one is a clear
 *  message instead of a mid-run SQL error. */
export async function selectMissingSchema(): Promise<string[]> {
  const rows = await query<{ what: string }>(
    `SELECT what FROM (VALUES
        ('sql/035 rider_stats_cache',   to_regclass('rider_stats_cache') IS NOT NULL),
        ('sql/039 rider_period_stats',  to_regclass('rider_period_stats') IS NOT NULL),
        ('sql/029 app_flags',           to_regclass('app_flags') IS NOT NULL),
        ('sql/034 users.weight_kg',     EXISTS (SELECT 1 FROM information_schema.columns
                                                 WHERE table_name = 'users' AND column_name = 'weight_kg')),
        ('sql/030 users.country',       EXISTS (SELECT 1 FROM information_schema.columns
                                                 WHERE table_name = 'users' AND column_name = 'country')),
        ('sql/044 users.stats_backfill_excluded', EXISTS (SELECT 1 FROM information_schema.columns
                                                 WHERE table_name = 'users' AND column_name = 'stats_backfill_excluded'))
      ) AS needs(what, present)
      WHERE NOT present`,
  );
  return rows.map((row) => row.what);
}
