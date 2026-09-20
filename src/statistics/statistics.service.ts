// Rider Statistics — orchestrates the cache-or-recompute read path, and the lifetime
// achievement view over it. See sql/035-rider-stats-cache.sql and statistics.queries.ts for the
// shape and the "trust participation, no GPS requirement" rule this is all built on.

import { logger } from "../lib/logger.js";
import { avatarFieldsOf } from "../lib/user-images.js";
import { getAppFlag, isAppFlagOn } from "../queries/appFlags.queries.js";
import { selectUserById } from "../queries/user.queries.js";
import {
  type AchievementProgress,
  achievementProgress,
  STAT_CATEGORIES,
} from "./statistics.achievements.js";
import { defaultSpeedForLevel, estimateCalories } from "./statistics.calories.js";
import { GEM_STATS, type Gem, type GemStat, gemFor } from "./statistics.gems.js";
import {
  isPeriodCacheUsable,
  isPeriodFinal,
  isValidPeriod,
  periodOf,
  periodsBetween,
  previousPeriod,
} from "./statistics.periods.js";
import {
  type CachedRiderStats,
  type FactsOptions,
  type FinishedRideFacts,
  type LeaderboardCategory,
  LIFETIME_YEAR,
  type PeriodType,
  type RiderStatsTotals,
  selectEventFinishedAt,
  selectFinishedEventParticipantUserIds,
  selectFinishedRideFactsForUser,
  selectFirstRidePeriod,
  selectLeaderboard,
  selectPeriodStats,
  selectStatsCache,
  upsertPeriodStats,
  upsertStatsCache,
} from "./statistics.queries.js";

/** app_flags key: when 'true', a ride only counts for a rider recorded as having turned up
 *  (attendance_status present — by auto check-in or the organizer; see checkinRuleSql in
 *  statistics.queries.ts) — but only for rides that started at/after CHECKIN_FROM_FLAG.
 *  Default off — sql/039. */
export const REQUIRE_CHECKIN_FLAG = "stats_require_live_checkin";

/** app_flags key: ISO-8601 instant the check-in requirement starts from (sql/044). Rides that
 *  started earlier predate auto check-in and keep counting on registration alone. */
export const CHECKIN_FROM_FLAG = "stats_live_checkin_from";

/** The rollout instant, or null for empty/unparseable — never a guessed date. */
export function parseCheckinFrom(raw: string | null): Date | null {
  const text = raw?.trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The rules every facts read uses — the live paths AND the history backfill, so the two can never
 * count differently. Read per computation, never cached here: app_flags has its own 30s cache.
 *
 * The check-in requirement needs BOTH flags: 'stats_require_live_checkin' on AND a valid rollout
 * instant. With the switch on but no usable instant it is NOT applied (and warned about): the
 * safe direction is keeping history, never dropping it. A failed read counts as OFF (the Phase 1
 * rule) — Statistics must never fail because of a flag.
 */
export async function resolveFactsOptions(): Promise<FactsOptions> {
  try {
    if (!(await isAppFlagOn(REQUIRE_CHECKIN_FLAG))) return { requireCheckinFrom: null };
    const from = parseCheckinFrom(await getAppFlag(CHECKIN_FROM_FLAG));
    if (!from) {
      logger.warn(
        `statistics: ${REQUIRE_CHECKIN_FLAG} is on but ${CHECKIN_FROM_FLAG} is empty/invalid; check-in requirement NOT applied`,
      );
    }
    return { requireCheckinFrom: from };
  } catch (err) {
    logger.warn({ err }, "statistics: could not read the check-in flags; treating as off");
    return { requireCheckinFrom: null };
  }
}

/** A cache row older than this is treated as stale and recomputed on next read. Not the only
 *  path to freshness — see refreshStatsForFinishedEvent below, the eager one. */
const STATS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CallerContext {
  weightKg: number | null;
  country: string | null;
}

async function getCallerContext(userId: number): Promise<CallerContext> {
  const user = await selectUserById(userId);
  return { weightKg: user?.weightKg ?? null, country: user?.country ?? null };
}

function isFresh(cached: CachedRiderStats | null): cached is CachedRiderStats {
  return cached != null && Date.now() - cached.computedAt.getTime() < STATS_CACHE_MAX_AGE_MS;
}

/**
 * One ride's speed, for the calorie/hours estimate — REAL data first, organizer's stated plan
 * second, a rider-level guess last. Never a rider-typed "average speed" preference: this app
 * does not collect one server-side, on purpose.
 */
function speedForRide(fact: FinishedRideFacts): number {
  if (fact.durationHours && fact.durationHours > 0) return fact.distanceKm / fact.durationHours;
  if (fact.organizerDurationMin && fact.organizerDurationMin > 0) {
    return fact.distanceKm / (fact.organizerDurationMin / 60);
  }
  return defaultSpeedForLevel(fact.level);
}

/** Hours for one ride — real GPS elapsed time when there is one, otherwise the same
 *  distance/speed estimate the calorie total already relies on. Never double free: this is the
 *  SAME speed the calorie figure for this ride uses, just expressed as hours instead of kcal. */
function hoursForRide(fact: FinishedRideFacts): number {
  if (fact.durationHours && fact.durationHours > 0) return fact.durationHours;
  if (fact.distanceKm <= 0) return 0;
  return fact.distanceKm / speedForRide(fact);
}

function computeTotals(
  facts: readonly FinishedRideFacts[],
  weightKg: number | null,
): RiderStatsTotals {
  let ridesCount = 0;
  let totalKm = 0;
  let totalClimbM = 0;
  let totalHours = 0;
  let totalCalories: number | null = weightKg != null ? 0 : null;

  for (const fact of facts) {
    ridesCount += 1;
    totalKm += fact.distanceKm;
    totalClimbM += fact.elevationM;
    totalHours += hoursForRide(fact);
    if (weightKg != null) {
      const kcal = estimateCalories({
        distanceKm: fact.distanceKm,
        climbM: fact.elevationM,
        weightKg,
        speedKmh: speedForRide(fact),
      });
      totalCalories = (totalCalories ?? 0) + (kcal ?? 0);
    }
  }

  return {
    ridesCount,
    totalKm: Math.round(totalKm * 10) / 10,
    totalClimbM: Math.round(totalClimbM),
    totalHours: Math.round(totalHours * 10) / 10,
    totalCalories: totalCalories == null ? null : Math.round(totalCalories),
  };
}

export interface YearStats {
  year: number;
  rides: number;
  distanceKm: number;
  climbM: number;
  hours: number;
  calories: number | null;
}

export interface RiderStatsPayload {
  userId: number;
  generatedAt: string;
  /** Present only so the client can show/hide the "set your weight to see calories" prompt
   *  without a second round trip. */
  weightKg: number | null;
  lifetime: {
    rides: number;
    distanceKm: number;
    climbM: number;
    hours: number;
    calories: number | null;
  };
  /** Every calendar year this rider has at least one completed ride in, newest first. */
  byYear: YearStats[];
  /** LIFETIME-only tiers, for StatisticsPage.tsx's "Next Milestone" card — a rider's tier does
   *  not reset when they switch the page's year tab. */
  achievements: AchievementProgress[];
}

function toYearStats(year: number, totals: RiderStatsTotals): YearStats {
  return {
    year,
    rides: totals.ridesCount,
    distanceKm: totals.totalKm,
    climbM: totals.totalClimbM,
    hours: totals.totalHours,
    calories: totals.totalCalories,
  };
}

/**
 * The full /statistics/me payload. Recomputes (and re-caches) any scope — lifetime, or one of
 * the rider's years — whose cache row is missing or older than 24h; a fresh row is served as-is.
 * One fetch of the raw facts covers every scope this request needs, however many years that is.
 */
export async function getRiderStatsPayload(userId: number): Promise<RiderStatsPayload> {
  const [lifetimeCached, { weightKg, country }] = await Promise.all([
    selectStatsCache(userId, LIFETIME_YEAR),
    getCallerContext(userId),
  ]);

  // KNOWN COST, ACCEPTED FOR PHASE 1: the year-tab selector needs to know which years this
  // rider has ridden in, and nothing caches that list on its own — so the raw per-ride facts
  // are read once even when every cache row is already fresh. What the cache still avoids is
  // the expensive part (the participant_tracks/events/route join, run once per SCOPE), not this
  // one cheap read.
  let facts: FinishedRideFacts[] | null = null;
  async function factsOnce(): Promise<FinishedRideFacts[]> {
    if (!facts) facts = await selectFinishedRideFactsForUser(userId, await resolveFactsOptions());
    return facts;
  }

  const lifetime = isFresh(lifetimeCached)
    ? lifetimeCached
    : await recomputeScope(userId, LIFETIME_YEAR, country, await factsOnce(), weightKg);

  const years = [...new Set((await factsOnce()).map((f) => f.year))].sort((a, b) => b - a);
  const byYear = await Promise.all(
    years.map(async (year) => {
      const cached = await selectStatsCache(userId, year);
      const totals = isFresh(cached)
        ? cached
        : await recomputeScope(userId, year, country, await factsOnce(), weightKg);
      return toYearStats(year, totals);
    }),
  );

  const achievements = STAT_CATEGORIES.map((category) =>
    achievementProgress(category, lifetimeValueFor(category, lifetime)),
  );

  return {
    userId,
    generatedAt: new Date().toISOString(),
    weightKg,
    lifetime: toYearStats(LIFETIME_YEAR, lifetime),
    byYear,
    achievements,
  };
}

function lifetimeValueFor(
  category: (typeof STAT_CATEGORIES)[number],
  totals: RiderStatsTotals,
): number {
  switch (category) {
    case "rides":
      return totals.ridesCount;
    case "km":
      return totals.totalKm;
    case "climbM":
      return totals.totalClimbM;
    case "calories":
      return totals.totalCalories ?? 0;
  }
}

async function recomputeScope(
  userId: number,
  year: number,
  country: string | null,
  facts: readonly FinishedRideFacts[],
  weightKg: number | null,
): Promise<RiderStatsTotals> {
  const scoped = year === LIFETIME_YEAR ? facts : facts.filter((f) => f.year === year);
  const totals = computeTotals(scoped, weightKg);
  await upsertStatsCache(userId, year, country, totals);
  return totals;
}

/**
 * Called right after an event reaches 'finished' — by the organizer's finish (event.service.ts's
 * changeEventStatus) or by the auto-finish sweeper (autoFinish.service.ts) — and the ONLY
 * integration point this subsystem has with the rest of the app. Takes just the eventId so the
 * callers need no knowledge of Statistics' internals; looks up the roster itself.
 *
 * Eager, not lazy — a finished ride's roster is small enough (tens of riders, not thousands)
 * that recomputing each of them synchronously here is cheap next to everything else those
 * callers already do (writeParticipantTracks). Never throws — a Statistics failure must never
 * undo a ride finishing; see the try/catch below.
 *
 * Refreshes LIFETIME plus the year and month the ride FINISHED in — read from events.finished_at,
 * not from "now": an auto-finished ride is stamped with its own end time, which can be in an
 * earlier month than the sweep that closed it. Every other period row is untouched by it.
 *
 * `onlyUserIds` narrows the refresh to those riders instead of the whole roster — used when one
 * rider's numbers change after the finish (refreshStatsAfterAttendanceChange below).
 */
export async function refreshStatsForFinishedEvent(
  eventId: string,
  onlyUserIds?: readonly number[],
): Promise<void> {
  const finishedAt =
    (await selectEventFinishedAt(eventId).catch((err: unknown) => {
      logger.warn({ eventId, err }, "refreshStatsForFinishedEvent: could not read finished_at");
      return null;
    })) ?? new Date();
  const year = finishedAt.getUTCFullYear();
  const month = periodOf("month", finishedAt);
  const userIds =
    onlyUserIds ??
    (await selectFinishedEventParticipantUserIds(eventId).catch((err: unknown) => {
      // Logged, never thrown — see the per-user catch below for why. Caught here too: this
      // lookup itself can fail (e.g. rider_stats_cache/034/035 not migrated yet on this
      // database), and a silent [] would look identical to "an event with no riders" instead of
      // the real cause.
      logger.warn({ eventId, err }, "refreshStatsForFinishedEvent: could not list finishers");
      return [];
    }));
  const options = await resolveFactsOptions();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const [facts, { weightKg, country }] = await Promise.all([
          selectFinishedRideFactsForUser(userId, options),
          getCallerContext(userId),
        ]);
        await Promise.all([
          recomputeScope(userId, LIFETIME_YEAR, country, facts, weightKg),
          recomputeScope(userId, year, country, facts, weightKg),
          recomputePeriod(userId, "month", month, facts, weightKg),
          recomputePeriod(userId, "year", String(year), facts, weightKg),
        ]);
      } catch (err) {
        // Never let a stats refresh take a finish down — a stale cache row self-heals on this
        // rider's next read (the 24h fallback), so a failure here costs at most "the numbers are
        // a bit late", never a broken finish. Logged rather than silent, though: this is the ONLY
        // signal an operator gets that Statistics migrations (sql/034/035/039) haven't been run
        // yet, or that something else here is consistently broken.
        logger.warn({ eventId, userId, err }, "refreshStatsForFinishedEvent: failed for one rider");
      }
    }),
  );
}

/**
 * An organizer changed one rider's attendance on a ride that has ALREADY finished. While
 * stats_require_live_checkin is on, attendance decides whether the ride counts for that rider, so
 * their numbers are rebuilt now instead of waiting for the 24h fallback (a settled period would
 * never be rebuilt at all). With the flag off attendance cannot change any total, so this does
 * nothing. Same recompute as the finish hook, narrowed to the one rider; never throws.
 */
export async function refreshStatsAfterAttendanceChange(
  eventId: string,
  userId: number,
): Promise<void> {
  if (!(await resolveFactsOptions()).requireCheckinFrom) return;
  await refreshStatsForFinishedEvent(eventId, [userId]);
}

// ---- The month / year timeline (GET /statistics/periods) --------------------------------------

type StatValues = {
  rides: number;
  distanceKm: number;
  climbM: number;
  hours: number;
  calories: number | null;
};

export interface PeriodEntry extends StatValues {
  /** 'YYYY-MM' for a month, 'YYYY' for a year. */
  period: string;
  gems: Record<GemStat, Gem>;
  /** The immediately older period's numbers, for the trend arrows. Always present (a period with
   *  no rides is all zeros — the client shows no percentage against a zero baseline). */
  previous: StatValues;
  /** True once the period is over AND its numbers can never change again — the client may keep
   *  the row forever. False for the current period and for a just-closed one still being settled. */
  final: boolean;
}

export interface PeriodTimelinePayload {
  periodType: PeriodType;
  generatedAt: string;
  /** Lets the client show the "set your weight to see calories" prompt without a second call. */
  weightKg: number | null;
  /** Newest first, contiguous (empty months included) from the rider's first ride — or from the
   *  requested `from` — up to the current period. */
  periods: PeriodEntry[];
}

function toStatValues(totals: RiderStatsTotals): StatValues {
  return {
    rides: totals.ridesCount,
    distanceKm: totals.totalKm,
    climbM: totals.totalClimbM,
    hours: totals.totalHours,
    calories: totals.totalCalories,
  };
}

function gemsFor(periodType: PeriodType, values: StatValues): Record<GemStat, Gem> {
  const byStat: Record<GemStat, number | null> = {
    rides: values.rides,
    distance: values.distanceKm,
    climb: values.climbM,
    hours: values.hours,
    calories: values.calories,
  };
  return Object.fromEntries(
    GEM_STATS.map((stat) => [stat, gemFor(periodType, stat, byStat[stat])]),
  ) as Record<GemStat, Gem>;
}

function factsInPeriod(
  facts: readonly FinishedRideFacts[],
  type: PeriodType,
  period: string,
): FinishedRideFacts[] {
  return facts.filter((f) =>
    type === "year"
      ? String(f.year) === period
      : `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}` === period,
  );
}

async function recomputePeriod(
  userId: number,
  type: PeriodType,
  period: string,
  facts: readonly FinishedRideFacts[],
  weightKg: number | null,
): Promise<RiderStatsTotals> {
  const totals = computeTotals(factsInPeriod(facts, type, period), weightKg);
  await upsertPeriodStats(userId, type, period, totals);
  return totals;
}

export interface RiderHistory {
  /** 'YYYY-MM' of the earliest counted ride. */
  firstPeriod: string;
  /** What rider_stats_cache holds for LIFETIME_YEAR. */
  lifetime: RiderStatsTotals;
  /** rider_stats_cache year scopes — only years with a ride, exactly as the live path writes. */
  cacheYears: { year: number; totals: RiderStatsTotals }[];
  /** rider_period_stats month rows: contiguous, oldest first, first ride's month through `now`
   *  (empty months included — the timeline shows them). */
  months: { period: string; totals: RiderStatsTotals }[];
  /** rider_period_stats year rows: contiguous, oldest first, likewise. */
  years: { period: string; totals: RiderStatsTotals }[];
  /** Rides that fall in no month row (finished_at in the future, or older than the timeline's
   *  MAX_TIMELINE_PERIODS window). Still in `lifetime`; never silently lost from the report. */
  ridesOutsideMonthRows: number;
}

/**
 * Every row the history backfill writes for one rider — computed from their ride facts with the
 * SAME computeTotals / factsInPeriod the live finish hook and timeline use, so a backfilled month
 * can never differ from what a live recompute of that month would produce. Pure: no I/O.
 * Null when the rider has no counted ride at all.
 */
export function buildRiderHistory(
  facts: readonly FinishedRideFacts[],
  weightKg: number | null,
  now: Date = new Date(),
): RiderHistory | null {
  if (facts.length === 0) return null;

  const monthKey = (f: FinishedRideFacts) =>
    `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}`;
  const firstPeriod = facts.map(monthKey).sort()[0];

  const monthPeriods = periodsBetween("month", firstPeriod, periodOf("month", now)).reverse();
  const yearPeriods = periodsBetween(
    "year",
    firstPeriod.slice(0, 4),
    periodOf("year", now),
  ).reverse();
  const inMonthRows = new Set(monthPeriods);
  const cacheYears = [...new Set(facts.map((f) => f.year))].sort((a, b) => a - b);

  return {
    firstPeriod,
    lifetime: computeTotals(facts, weightKg),
    cacheYears: cacheYears.map((year) => ({
      year,
      totals: computeTotals(
        facts.filter((f) => f.year === year),
        weightKg,
      ),
    })),
    months: monthPeriods.map((period) => ({
      period,
      totals: computeTotals(factsInPeriod(facts, "month", period), weightKg),
    })),
    years: yearPeriods.map((period) => ({
      period,
      totals: computeTotals(factsInPeriod(facts, "year", period), weightKg),
    })),
    ridesOutsideMonthRows: facts.filter((f) => !inMonthRows.has(monthKey(f))).length,
  };
}

/**
 * The rider's month-by-month (or year-by-year) results.
 *
 *  - the CURRENT period is a real query, cached 24h (and rebuilt the moment a ride finishes)
 *  - a period that has ended is computed once, then final — never queried again
 *
 * `from` lets a client that already holds the settled history ask only for what it lacks (the
 * oldest period it is not sure of, through now). Without it, the whole history is returned,
 * starting at the rider's first ride. Raw facts are only read when some requested period is
 * missing or unusable in the cache.
 */
export async function getPeriodTimeline(
  userId: number,
  periodType: PeriodType,
  from?: string,
): Promise<PeriodTimelinePayload> {
  const now = new Date();
  const current = periodOf(periodType, now);
  const [{ weightKg }, options] = await Promise.all([
    getCallerContext(userId),
    resolveFactsOptions(),
  ]);

  let oldest: string;
  if (from && isValidPeriod(periodType, from)) {
    oldest = from;
  } else {
    const first = await selectFirstRidePeriod(userId, options);
    oldest = first ? (periodType === "year" ? first.slice(0, 4) : first) : current;
  }
  if (oldest > current) oldest = current;

  // One extra period BELOW the oldest shown: it is only there to be the trend baseline.
  const wanted = periodsBetween(periodType, previousPeriod(periodType, oldest), current);
  const cached = await selectPeriodStats(userId, periodType, wanted);

  const totalsByPeriod = new Map<string, { totals: RiderStatsTotals; computedAt: Date }>();
  const missing: string[] = [];
  for (const period of wanted) {
    const hit = cached.get(period);
    if (hit && isPeriodCacheUsable(periodType, period, hit.computedAt, now)) {
      totalsByPeriod.set(period, { totals: hit, computedAt: hit.computedAt });
    } else {
      missing.push(period);
    }
  }

  if (missing.length > 0) {
    const facts = await selectFinishedRideFactsForUser(userId, options);
    await Promise.all(
      missing.map(async (period) => {
        const totals = await recomputePeriod(userId, periodType, period, facts, weightKg);
        totalsByPeriod.set(period, { totals, computedAt: new Date() });
      }),
    );
  }

  const periods: PeriodEntry[] = [];
  for (let i = 0; i < wanted.length - 1; i += 1) {
    const period = wanted[i];
    const entry = totalsByPeriod.get(period);
    const before = totalsByPeriod.get(wanted[i + 1]);
    if (!entry || !before) continue;
    const values = toStatValues(entry.totals);
    periods.push({
      period,
      ...values,
      gems: gemsFor(periodType, values),
      previous: toStatValues(before.totals),
      final: isPeriodFinal(periodType, period, entry.computedAt, now),
    });
  }

  return { periodType, generatedAt: now.toISOString(), weightKg, periods };
}

export interface LeaderboardPayload {
  category: LeaderboardCategory;
  period: "lifetime" | "year";
  year: number;
  country: string;
  top: {
    userId: number;
    displayName: string;
    /** Resolved the same way every other avatar in the app is (upload > preset > Google photo
     *  > none) — see avatarFieldsOf. The raw avatar_type/avatar_value columns never leave this
     *  file; a leaderboard response only ever carries a ready-to-render URL or null. */
    avatarUrl: string | null;
    value: number;
    rank: number;
  }[];
  /** The caller's own row, always present with a real rank UNLESS they have never opened
   *  Statistics for this scope, or have no country set (see selectLeaderboard). */
  me: LeaderboardPayload["top"][number] | null;
}

/**
 * The caller's own cache row for this scope is refreshed first, every time — a leaderboard that
 * could show YOU a number that isn't actually yours right now (e.g. right after your own ride
 * just finished, before the 24h window would otherwise catch it) would be worse than other
 * riders' rows lagging slightly behind. Other riders' rows are read as cached, per the whole
 * point of this table.
 *
 * `country` defaults to the caller's own users.country — a National Leaderboard is about the
 * rider's own country's community, not where any one ride physically happened (events.country).
 * A caller with no country set yet gets an empty leaderboard (`top: [], me: null`) rather than
 * an inferred/guessed one.
 */
export async function getLeaderboard(
  callerUserId: number,
  category: LeaderboardCategory,
  period: "lifetime" | "year",
  requestedYear: number | undefined,
  requestedCountry: string | undefined,
): Promise<LeaderboardPayload> {
  const year =
    period === "lifetime" ? LIFETIME_YEAR : (requestedYear ?? new Date().getUTCFullYear());
  const { weightKg, country: callerCountry } = await getCallerContext(callerUserId);
  const country = requestedCountry ?? callerCountry;

  if (!country) {
    return { category, period, year, country: "", top: [], me: null };
  }

  const cached = await selectStatsCache(callerUserId, year);
  if (!isFresh(cached)) {
    const facts = await selectFinishedRideFactsForUser(callerUserId, await resolveFactsOptions());
    await recomputeScope(callerUserId, year, callerCountry, facts, weightKg);
  }

  const { top, me } = await selectLeaderboard(category, year, country, callerUserId);
  const resolve = (row: (typeof top)[number]) => ({
    userId: row.userId,
    displayName: row.displayName,
    avatarUrl: avatarFieldsOf({
      avatarUrl: row.avatarUrl,
      avatarType: row.avatarType,
      avatarValue: row.avatarValue,
    }).avatarUrl,
    value: row.value,
    rank: row.rank,
  });
  return { category, period, year, country, top: top.map(resolve), me: me ? resolve(me) : null };
}
