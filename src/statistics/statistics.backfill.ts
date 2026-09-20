// Statistics history backfill — rebuilds every real rider's month / year (and lifetime) rows from
// the rides they ACTUALLY took, so a rider who joined before Statistics shipped does not start
// from an empty history. One-time, but written to be re-run at any time.
//
// SAME LOGIC AS LIVE, NOT A COPY OF IT
//   * which rides count       -> selectFinishedRideFactsForUser (the live facts query), called
//                                with the live flag rules (resolveFactsOptions)
//   * what a period is worth  -> buildRiderHistory, which calls the live computeTotals /
//                                factsInPeriod
//   * where it is written     -> rider_period_stats + rider_stats_cache, the tables the finish
//                                hook writes, with the same ON CONFLICT upsert
//   Nothing here re-derives km, climb, hours or calories.
//
// HISTORICAL RIDES AND CHECK-IN
//   Rides before Auto Check-in have no reliable attendance, so they must not need it. That is not
//   special-cased here: the live rule is itself prospective (stats_live_checkin_from, sql/044),
//   so the same facts query that serves live riders counts a pre-rollout ride on registration
//   alone. Whatever the flags say today, the backfill and the live system agree.
//
// SAFETY
//   * Read-only unless `execute` is set — the dry-run path never reaches a write function.
//   * Idempotent: rows are keyed by (user, period_type, period) and overwritten with the value
//     the live logic computes; a second run finds nothing to change. No row is ever invented for
//     a ride that did not happen: rides come from event_participants + finished events only.
//   * Per-rider transaction: a rider is written completely or not at all, and one rider's failure
//     never stops the others.
//   * Resumable: riders are processed in id order and the report names the last id reached
//     (`afterUserId` continues from it). Re-running from the start is equally safe.
//   * Excluded accounts (users.stats_backfill_excluded, sql/044) are listed and never written.

import { withTransaction } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { AUTO_FINISHABLE_STATUSES } from "../queries/event.queries.js";
import { AUTO_FINISH_GRACE_HOURS } from "../services/autoFinish.service.js";
import {
  type BackfillCandidate,
  type CandidateFilter,
  selectBackfillCandidates,
  selectParticipationBreakdown,
  selectStatsCacheRows,
  upsertPeriodStatsBatch,
} from "./statistics.backfill.queries.js";
import { isPeriodCacheUsable } from "./statistics.periods.js";
import {
  type CachedRiderStats,
  type PeriodType,
  type RiderStatsTotals,
  selectFinishedRideFactsForUser,
  selectPeriodStats,
  upsertStatsCache,
} from "./statistics.queries.js";
import { buildRiderHistory, type RiderHistory, resolveFactsOptions } from "./statistics.service.js";

/** Stop instead of grinding through every rider when the database is plainly unwell. */
const MAX_CONSECUTIVE_FAILURES = 10;

export interface BackfillOptions {
  /** false (the default) = dry run: read, compute, report — write nothing. */
  execute?: boolean;
  /** Only create rows that do not exist yet; never overwrite one that does. */
  onlyMissing?: boolean;
  filter?: CandidateFilter;
  /** Test seam; the clock the period range and cache-freshness rule are evaluated against. */
  now?: Date;
  onProgress?: (line: string) => void;
}

/** Per row kind. `unchanged` = left as it is (identical numbers, or --only-missing). */
export interface RowCounts {
  create: number;
  update: number;
  unchanged: number;
}

export interface BackfillReport {
  mode: "dry-run" | "execute";
  generatedAt: string;
  /** The check-in rule in force for this run; null = registration alone counts everywhere. */
  checkInRequiredFrom: string | null;
  onlyMissing: boolean;
  /** Accounts with at least one confirmed ride on a finished event, before exclusions. */
  ridersFound: number;
  ridersExcluded: { count: number; userIds: number[] };
  /** Rider rows planned (dry-run) or written (execute) — riders with >= 1 counted ride. */
  ridersProcessed: number;
  /** Found and not excluded, but none of their rides count under the current rules. */
  ridersWithoutCountedRides: number;
  /** Counted rides across processed riders. */
  ridesConsidered: number;
  /** rider_period_stats month rows (dry-run: to create/update; execute: created/updated). */
  months: RowCounts;
  /** rider_period_stats year rows. */
  years: RowCounts;
  /** rider_stats_cache rows (lifetime + one per ridden year) — what leaderboards/`/me` read. */
  cacheRows: RowCounts;
  /** Participations that did not count, with the reason — plus the 'counted' total for cross-check. */
  ignored: { reason: string; participations: number }[];
  countedParticipations: number;
  warnings: string[];
  failures: { userId: number; error: string }[];
  /** The last rider id reached — pass as `afterUserId` to continue a stopped run. */
  lastUserId: number | null;
  aborted: boolean;
}

function emptyCounts(): RowCounts {
  return { create: 0, update: 0, unchanged: 0 };
}

function sameTotals(a: RiderStatsTotals, b: RiderStatsTotals): boolean {
  return (
    a.ridesCount === b.ridesCount &&
    a.totalKm === b.totalKm &&
    a.totalClimbM === b.totalClimbM &&
    a.totalHours === b.totalHours &&
    a.totalCalories === b.totalCalories
  );
}

type RowAction = "create" | "update" | "unchanged";

/**
 * What writing `totals` over `existing` would do. A row with identical numbers is left alone
 * unless the live rule would not trust it as final (a period row computed before its period
 * settled): that one is rewritten so it is final from now on.
 */
function classifyPeriodRow(
  existing: CachedRiderStats | undefined,
  totals: RiderStatsTotals,
  type: PeriodType,
  period: string,
  now: Date,
  onlyMissing: boolean,
): RowAction {
  if (!existing) return "create";
  if (onlyMissing) return "unchanged";
  if (!sameTotals(existing, totals)) return "update";
  return isPeriodCacheUsable(type, period, existing.computedAt, now) ? "unchanged" : "update";
}

function classifyCacheRow(
  existing: CachedRiderStats | undefined,
  totals: RiderStatsTotals,
  onlyMissing: boolean,
): RowAction {
  if (!existing) return "create";
  if (onlyMissing) return "unchanged";
  return sameTotals(existing, totals) ? "unchanged" : "update";
}

interface RiderPlan {
  history: RiderHistory;
  months: { period: string; totals: RiderStatsTotals; action: RowAction }[];
  years: { period: string; totals: RiderStatsTotals; action: RowAction }[];
  cache: { year: number; totals: RiderStatsTotals; action: RowAction }[];
}

/** What this rider's history would do to the tables, given what is already there. Read-only. */
async function planRider(
  candidate: BackfillCandidate,
  history: RiderHistory,
  now: Date,
  onlyMissing: boolean,
): Promise<RiderPlan> {
  const [existingMonths, existingYears, existingCache] = await Promise.all([
    selectPeriodStats(
      candidate.userId,
      "month",
      history.months.map((m) => m.period),
    ),
    selectPeriodStats(
      candidate.userId,
      "year",
      history.years.map((y) => y.period),
    ),
    selectStatsCacheRows(candidate.userId),
  ]);
  return {
    history,
    months: history.months.map((m) => ({
      ...m,
      action: classifyPeriodRow(
        existingMonths.get(m.period),
        m.totals,
        "month",
        m.period,
        now,
        onlyMissing,
      ),
    })),
    years: history.years.map((y) => ({
      ...y,
      action: classifyPeriodRow(
        existingYears.get(y.period),
        y.totals,
        "year",
        y.period,
        now,
        onlyMissing,
      ),
    })),
    cache: [
      {
        year: 0,
        totals: history.lifetime,
        action: classifyCacheRow(existingCache.get(0), history.lifetime, onlyMissing),
      },
      ...history.cacheYears.map((y) => ({
        ...y,
        action: classifyCacheRow(existingCache.get(y.year), y.totals, onlyMissing),
      })),
    ],
  };
}

async function writeRider(candidate: BackfillCandidate, plan: RiderPlan): Promise<void> {
  const changed = <T extends { action: RowAction }>(rows: T[]) =>
    rows.filter((row) => row.action !== "unchanged");
  await withTransaction(async (tx) => {
    for (const row of changed(plan.cache)) {
      await upsertStatsCache(candidate.userId, row.year, candidate.country, row.totals, tx);
    }
    await upsertPeriodStatsBatch(candidate.userId, "month", changed(plan.months), tx);
    await upsertPeriodStatsBatch(candidate.userId, "year", changed(plan.years), tx);
  });
}

function tally(counts: RowCounts, rows: { action: RowAction }[]): void {
  for (const row of rows) counts[row.action] += 1;
}

export async function runStatsBackfill(options: BackfillOptions = {}): Promise<BackfillReport> {
  const execute = options.execute === true;
  const onlyMissing = options.onlyMissing === true;
  const filter = options.filter ?? {};
  const now = options.now ?? new Date();
  const progress = options.onProgress ?? (() => {});

  const factsOptions = await resolveFactsOptions();
  const report: BackfillReport = {
    mode: execute ? "execute" : "dry-run",
    generatedAt: now.toISOString(),
    checkInRequiredFrom: factsOptions.requireCheckinFrom?.toISOString() ?? null,
    onlyMissing,
    ridersFound: 0,
    ridersExcluded: { count: 0, userIds: [] },
    ridersProcessed: 0,
    ridersWithoutCountedRides: 0,
    ridesConsidered: 0,
    months: emptyCounts(),
    years: emptyCounts(),
    cacheRows: emptyCounts(),
    ignored: [],
    countedParticipations: 0,
    warnings: [],
    failures: [],
    lastUserId: null,
    aborted: false,
  };

  const candidates = await selectBackfillCandidates(filter);
  report.ridersFound = candidates.length;
  let ridesOutsideMonthRows = 0;
  let consecutiveFailures = 0;

  for (const candidate of candidates) {
    if (candidate.excluded) {
      report.ridersExcluded.count += 1;
      report.ridersExcluded.userIds.push(candidate.userId);
      report.lastUserId = candidate.userId;
      continue;
    }

    try {
      const facts = await selectFinishedRideFactsForUser(candidate.userId, factsOptions);
      const history = buildRiderHistory(facts, candidate.weightKg, now);
      if (!history) {
        report.ridersWithoutCountedRides += 1;
      } else {
        const plan = await planRider(candidate, history, now, onlyMissing);
        if (execute) await writeRider(candidate, plan);
        report.ridersProcessed += 1;
        report.ridesConsidered += facts.length;
        ridesOutsideMonthRows += history.ridesOutsideMonthRows;
        tally(report.months, plan.months);
        tally(report.years, plan.years);
        tally(report.cacheRows, plan.cache);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      report.failures.push({ userId: candidate.userId, error: message });
      logger.warn({ err, userId: candidate.userId }, "stats backfill: rider failed");
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        report.aborted = true;
        report.warnings.push(
          `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive rider failures — fix the cause, then resume with afterUserId=${report.lastUserId ?? 0}`,
        );
        break;
      }
    }
    report.lastUserId = candidate.userId;
    const done = report.ridersProcessed + report.ridersWithoutCountedRides + report.failures.length;
    if (done % 25 === 0) progress(`... ${done} riders handled, last user id ${candidate.userId}`);
  }

  const breakdown = await selectParticipationBreakdown(filter, {
    requireCheckinFrom: factsOptions.requireCheckinFrom ?? null,
    autoFinishGraceHours: AUTO_FINISH_GRACE_HOURS,
    autoFinishStatuses: AUTO_FINISHABLE_STATUSES,
  });
  report.countedParticipations =
    breakdown.find((row) => row.reason === "counted")?.participations ?? 0;
  report.ignored = breakdown.filter((row) => row.reason !== "counted");
  if (ridesOutsideMonthRows > 0) {
    report.ignored.push({
      reason:
        "counted_in_lifetime_but_outside_month_rows (finished_at in the future or > 20 years back)",
      participations: ridesOutsideMonthRows,
    });
  }

  // The breakdown explains skips with its own SQL; the facts are what was really counted. They
  // must agree — when they do not, the report says so instead of quietly trusting either side.
  const comparable = filter.limit === undefined && !report.aborted && report.failures.length === 0;
  if (comparable && report.countedParticipations !== report.ridesConsidered) {
    report.warnings.push(
      `cross-check: breakdown says ${report.countedParticipations} counted participations but ${report.ridesConsidered} rides were considered — rides may have changed mid-run, or the two queries have drifted; investigate before executing`,
    );
  }
  return report;
}
