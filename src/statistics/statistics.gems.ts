// Rider Statistics — the gem a month or a year earns, per metric. CODE, not a table, for the same
// reason as statistics.achievements.ts: a threshold is a product decision that belongs in review
// and git history.
//
// THE CLIENT NEVER COMPUTES A GEM (StatisticsAchievementsPage.tsx renders `gem` as sent). That is
// why this lives on the server: the numbers differ per metric AND per month-vs-year, and changing
// them must not need a client release.
//
// ⚠ PRODUCT SIGN-OFF NEEDED. These thresholds are first-pass defaults, chosen so a casual rider
// (a few rides a month) lands on Onyx/Emerald and Ruby/Diamond mean a genuinely big month or
// year. They are NOT the lifetime tiers in statistics.achievements.ts (a different concept: one
// ladder over a whole career) and nothing else depends on them — retuning is a one-file change.
//
// Each tuple is the MINIMUM value for Onyx, Emerald, Ruby, Diamond in that order. Anything below
// the first number — including 0 — is Stone.

import type { PeriodType } from "./statistics.queries.js";

export const GEMS = ["stone", "onyx", "emerald", "ruby", "diamond"] as const;
export type Gem = (typeof GEMS)[number];

export const GEM_STATS = ["hours", "rides", "calories", "distance", "climb"] as const;
export type GemStat = (typeof GEM_STATS)[number];

type Thresholds = readonly [onyx: number, emerald: number, ruby: number, diamond: number];

export const GEM_THRESHOLDS: Record<PeriodType, Record<GemStat, Thresholds>> = {
  month: {
    rides: [2, 5, 10, 15],
    distance: [50, 150, 300, 500],
    climb: [500, 1500, 3000, 5000],
    hours: [4, 10, 20, 35],
    calories: [1500, 4000, 8000, 14000],
  },
  year: {
    rides: [15, 40, 80, 150],
    distance: [500, 1500, 3000, 6000],
    climb: [5000, 15000, 30000, 60000],
    hours: [40, 110, 220, 420],
    calories: [15000, 40000, 80000, 160000],
  },
};

/** `value` null (calories for a rider with no weight set) is Stone: nothing was measured, so
 *  nothing is earned — and never a guess. */
export function gemFor(periodType: PeriodType, stat: GemStat, value: number | null): Gem {
  if (value == null) return "stone";
  const thresholds = GEM_THRESHOLDS[periodType][stat];
  let earned = 0;
  for (const threshold of thresholds) {
    if (value >= threshold) earned += 1;
  }
  return GEMS[earned];
}
