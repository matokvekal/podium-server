// Rider Statistics — orchestrates the cache-or-recompute read path, and the lifetime
// achievement view over it. See sql/035-rider-stats-cache.sql and statistics.queries.ts for the
// shape and the "trust participation, no GPS requirement" rule this is all built on.

import { avatarFieldsOf } from "../lib/user-images.js";
import { selectUserById } from "../queries/user.queries.js";
import {
  type AchievementProgress,
  achievementProgress,
  STAT_CATEGORIES,
} from "./statistics.achievements.js";
import { defaultSpeedForLevel, estimateCalories } from "./statistics.calories.js";
import {
  type CachedRiderStats,
  type FinishedRideFacts,
  type LeaderboardCategory,
  LIFETIME_YEAR,
  type RiderStatsTotals,
  selectFinishedEventParticipantUserIds,
  selectFinishedRideFactsForUser,
  selectLeaderboard,
  selectStatsCache,
  upsertStatsCache,
} from "./statistics.queries.js";

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
    if (!facts) facts = await selectFinishedRideFactsForUser(userId);
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
 * Called right after an event reaches 'finished' (event.service.ts's finish hook) — the ONLY
 * integration point this subsystem has with the rest of the app. Takes just the eventId so the
 * finish hook needs no knowledge of Statistics' internals; looks up the roster itself.
 *
 * Eager, not lazy — a finished ride's roster is small enough (tens of riders, not thousands)
 * that recomputing each of them synchronously here is cheap next to everything else that same
 * hook already does (writeParticipantTracks). Never throws — a Statistics failure must never
 * undo the organizer finishing their ride; see the try/catch below and this function's own
 * caller in event.service.ts.
 *
 * Refreshes LIFETIME and the CURRENT calendar year only — the ride that just finished cannot
 * belong to any other year, and a rider's older per-year rows are untouched by it.
 */
export async function refreshStatsForFinishedEvent(eventId: string): Promise<void> {
  const year = new Date().getUTCFullYear();
  const userIds = await selectFinishedEventParticipantUserIds(eventId).catch(() => []);
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const [facts, { weightKg, country }] = await Promise.all([
          selectFinishedRideFactsForUser(userId),
          getCallerContext(userId),
        ]);
        await Promise.all([
          recomputeScope(userId, LIFETIME_YEAR, country, facts, weightKg),
          recomputeScope(userId, year, country, facts, weightKg),
        ]);
      } catch {
        // Never let a stats refresh take the finish transition down — a stale cache row
        // self-heals on this rider's next /statistics/me read (the 24h fallback), so a failure
        // here costs at most "the milestone card is a bit late", never a broken finish.
      }
    }),
  );
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
    const facts = await selectFinishedRideFactsForUser(callerUserId);
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
