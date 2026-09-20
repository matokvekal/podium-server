// Rider Statistics — LIFETIME achievement tiers for the "Me" tab's Next Milestone card
// (StatisticsPage.tsx). CODE, not a database table, on purpose — same reasoning as
// authz/plans.ts: a threshold is a product decision, reviewed in git history, not a row a
// support script can quietly edit.
//
// THESE ARE THE REFERENCE-IMAGE-APPROVED THRESHOLDS (elnino-client's rider-stats-mock.ts /
// statisics/achivment/README.md), not the earlier placeholder set an unmerged draft of this
// backend once used (10/25/50/100/250) — that mismatch was flagged and is resolved here in
// favour of the numbers already shown in the reviewed UI mock, so swapping to real data changes
// no rider-visible tier boundary.
//
// NO "EARNED" STATE IS PERSISTED ANYWHERE. A rider's current tier is always computed fresh from
// their real lifetime total (statistics.service.ts) compared against this list — the same
// "counted from the real tables at check time, so it can never drift" rule user_limits' own
// header states.
//
// SCOPE NOTE: this is the LIFETIME 5-gem tier model only, feeding StatisticsPage.tsx's single
// "Next Milestone" card. It is a different, narrower concept from the per-period / per-metric
// gems on StatisticsAchievementsPage.tsx, whose thresholds live in statistics.gems.ts. Do not
// conflate the two.

export const STAT_CATEGORIES = ["rides", "km", "climbM", "calories"] as const;
export type StatCategory = (typeof STAT_CATEGORIES)[number];

export interface AchievementTier {
  /** The total (rides / km / climb metres / calories) at which this tier is reached. */
  threshold: number;
  /** Display name — Stone -> Onyx -> Emerald -> Ruby -> Diamond, matching the approved gem
   *  assets already shipped under public/images/statistics/achievements/. */
  name: string;
}

/**
 * Ascending order is REQUIRED — nextAchievement scans forward and stops at the first
 * `total < threshold`.
 */
export const ACHIEVEMENT_TIERS: Record<StatCategory, readonly AchievementTier[]> = {
  rides: [
    { threshold: 25, name: "Stone" },
    { threshold: 50, name: "Onyx" },
    { threshold: 100, name: "Emerald" },
    { threshold: 200, name: "Ruby" },
    { threshold: 400, name: "Diamond" },
  ],
  km: [
    { threshold: 1000, name: "Stone" },
    { threshold: 2500, name: "Onyx" },
    { threshold: 5000, name: "Emerald" },
    { threshold: 10000, name: "Ruby" },
    { threshold: 20000, name: "Diamond" },
  ],
  climbM: [
    { threshold: 10000, name: "Stone" },
    { threshold: 25000, name: "Onyx" },
    { threshold: 50000, name: "Emerald" },
    { threshold: 100000, name: "Ruby" },
    { threshold: 200000, name: "Diamond" },
  ],
  calories: [
    { threshold: 50000, name: "Stone" },
    { threshold: 100000, name: "Onyx" },
    { threshold: 250000, name: "Emerald" },
    { threshold: 500000, name: "Ruby" },
    { threshold: 1000000, name: "Diamond" },
  ],
};

export interface AchievementProgress {
  category: StatCategory;
  /** The highest tier already reached, or null when the rider hasn't hit the first one yet. */
  current: AchievementTier | null;
  /** The tier being worked toward, or null when every tier in the list is already reached. */
  next: AchievementTier | null;
  /** 0-100, only meaningful when `next` is not null. */
  progressPercent: number;
  /** How much more of the raw total is needed to reach `next`; 0 when `next` is null. */
  remaining: number;
}

/**
 * Where a rider stands in one category, from their raw total alone — no stored state, so this
 * is safe to call on every request and can never disagree with itself between two reads of the
 * same total.
 */
export function achievementProgress(category: StatCategory, total: number): AchievementProgress {
  const tiers = ACHIEVEMENT_TIERS[category];
  let current: AchievementTier | null = null;
  let next: AchievementTier | null = null;

  for (const tier of tiers) {
    if (total >= tier.threshold) current = tier;
    else {
      next = tier;
      break;
    }
  }

  if (!next) return { category, current, next: null, progressPercent: 100, remaining: 0 };

  const floor = current?.threshold ?? 0;
  const span = next.threshold - floor;
  const progressPercent =
    span <= 0 ? 0 : Math.min(100, Math.max(0, ((total - floor) / span) * 100));

  return {
    category,
    current,
    next,
    progressPercent: Math.round(progressPercent),
    remaining: Math.max(0, next.threshold - total),
  };
}
