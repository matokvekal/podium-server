// Plan definitions: what each plan ALLOWS.
//
// ⚠ NO PRICES LIVE HERE, and none ever should. A plan is a set of limits and features. What it
// costs, how it is billed, whether it is sold monthly or once, and who is invoiced are billing
// concerns — that module will write entitlement_grants rows and read nothing from this file.
// Keeping money out of authorization is what lets pricing change without a code review of the
// permission system.
//
// Definitions live in code rather than the database on purpose: a limit is a product decision,
// and product decisions belong in review and in git history. Adding a tier is an entry here;
// granting it to someone is a row in entitlement_grants.

import { getDefaultUserLimits, type UserLimits } from "../config/plan-limits.js";
import type { Feature } from "./capabilities.js";

/**
 * A plan's limits have the same shape as a user's limits, because granting a plan COPIES these
 * numbers into the user's user_limits row (syncUserLimitsToPlan). They are not read on the
 * request path — user_limits is.
 */
export type PlanLimits = UserLimits;

// The free tier IS the signup default, read once at module load. A plan grant that is later
// revoked or expires returns the user to exactly these numbers.
const FREE_LIMITS = getDefaultUserLimits();

export interface PlanDefinition {
  code: PlanCode;
  /** Human label for the client's upgrade prompts. Not a product name in a catalogue sense. */
  label: string;
  /**
   * Higher wins when someone holds several plan grants at once — a beta coupon on top of a
   * paid subscription must not demote them.
   */
  rank: number;
  limits: PlanLimits;
  features: readonly Feature[];
}

export const PLAN_CODES = ["free", "organizer_pro", "club"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/**
 * The pricing table's "Viewer" and "Rider" are not plans — they are a guest and a signed-in
 * user, which is layer 1. "Organizer Free" and "Organizer Pro" are the same person on
 * different plans, which is why only the organizing side appears here.
 */
export const PLANS: Record<PlanCode, PlanDefinition> = {
  free: {
    code: "free",
    label: "Free",
    rank: 0,
    limits: FREE_LIMITS,
    // ⚠ PRICING SWITCH — the one line that decides whether private rides are sellable.
    //
    // Ships INCLUDED on free, because "private rides could be a paid feature" was raised as an
    // idea, not a decision, and shipping it locked would silently take away something free
    // organizers can do today. All the plumbing to sell it exists and is tested: remove
    // "private_events" from this array and a free organizer must subscribe or spend a
    // one-time credit (entitlement_grants with quantity), with no other code change anywhere.
    features: ["private_events"],
  },

  organizer_pro: {
    code: "organizer_pro",
    label: "Organizer Pro",
    rank: 10,
    limits: {
      eventsPerWeek: 30,
      participantsPerEvent: 500,
      groupsPerEvent: 10,
      teamsPerOwner: 5,
    },
    features: ["private_events", "advanced_results"],
  },

  club: {
    code: "club",
    label: "Club",
    rank: 20,
    limits: {
      eventsPerWeek: 250,
      participantsPerEvent: 5000,
      groupsPerEvent: 25,
      teamsPerOwner: 50,
    },
    // "Multiple admins, many events, large groups and advanced management." Defined so the
    // policy already honours it; nothing sells it yet.
    features: ["private_events", "advanced_results", "co_organizers"],
  },
};

export const FREE_PLAN = PLANS.free;

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * Most generous wins, per limit, independently.
 *
 * Not "the highest-ranked plan's limits": someone holding a beta coupon *and* a subscription
 * must never end up worse off than with either alone, and the answer must not depend on which
 * row the database returned first.
 */
export function mergeLimits(plans: readonly PlanDefinition[]): PlanLimits {
  const all = plans.length > 0 ? plans : [FREE_PLAN];
  return {
    eventsPerWeek: Math.max(...all.map((p) => p.limits.eventsPerWeek)),
    participantsPerEvent: Math.max(...all.map((p) => p.limits.participantsPerEvent)),
    groupsPerEvent: Math.max(...all.map((p) => p.limits.groupsPerEvent)),
    teamsPerOwner: Math.max(...all.map((p) => p.limits.teamsPerOwner)),
  };
}
