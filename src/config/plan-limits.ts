// The single source of truth for DEFAULT limits — what a brand-new user, on no plan, may do.
//
// ── Where a limit actually comes from ──────────────────────────────────────────────────────
//
//   1. user_entitlements.<column>   a per-user override (sql/020-user-entitlements.sql).
//                                   No row = the defaults below apply.
//   2. the user's plan              src/authz/plans.ts — a plan is granted by an
//                                   entitlement_grants row, so nobody is "on" a paid plan
//                                   without one.
//   3. DEFAULT_PLAN_LIMITS          below. These ARE the free plan's numbers: PLANS.free reads
//                                   them, so changing a number here changes it for every free
//                                   user with no override, with no other edit anywhere.
//
//   effective = per-field (override ?? plan limit)
//
// ── What this file is NOT ──────────────────────────────────────────────────────────────────
//
// It holds no usage counters. What a user HAS used is counted from the real tables at check
// time (countEventsCreatedSince, countJoinedParticipants, countGroupsForEvent,
// countTeamsForOwner), so a stored counter can never drift from what actually happened.
//
// It holds no prices. What a plan costs is a billing concern; see the note at the top of
// src/authz/plans.ts.

export const DEFAULT_PLAN_LIMITS = {
  /** Rides one organizer may create in a rolling 7 days — not a calendar week. */
  maxEventsPerWeek: 3,
  /** Riders on one start list, however they got there: self-joined, added, or imported. */
  maxParticipantsPerEvent: 50,
  /** Ride groups within one event. */
  maxGroupsPerEvent: 2,
  /** Teams one person may own. */
  maxTeamsPerOwner: 2,
} as const;

/** The four resolved limits, as every caller downstream reads them. */
export interface EffectiveLimits {
  maxEventsPerWeek: number;
  maxParticipantsPerEvent: number;
  maxGroupsPerEvent: number;
  maxTeamsPerOwner: number;
}

/**
 * One user_entitlements row as the query layer hands it back, or null when the user has none.
 *
 * Only the three limits that vary per user in practice are stored; teams-per-owner is a plan
 * decision and is never overridden here. A missing row means "apply the plan / the defaults".
 */
export type UserEntitlementRow = {
  maxEventsPerWeek?: number;
  maxParticipantsPerEvent?: number;
  maxGroupsPerEvent?: number;
} | null;

export const DEFAULT_FREE_PLAN_LIMITS: EffectiveLimits = {
  maxEventsPerWeek: DEFAULT_PLAN_LIMITS.maxEventsPerWeek,
  maxParticipantsPerEvent: DEFAULT_PLAN_LIMITS.maxParticipantsPerEvent,
  maxGroupsPerEvent: DEFAULT_PLAN_LIMITS.maxGroupsPerEvent,
  maxTeamsPerOwner: DEFAULT_PLAN_LIMITS.maxTeamsPerOwner,
};

/**
 * The one function that answers "what may this user actually do".
 *
 * `planLimits` is what the user's plan allows (PLANS.free's limits when they hold no plan
 * grant, which is DEFAULT_PLAN_LIMITS). `entRow` is their per-user override. A present column
 * wins outright — including a LOWER number, so a limit can be tightened for one account as
 * well as raised. A missing column, or no row at all, inherits the plan value.
 *
 * `??`, never `||`: 0 is a real limit ("this account may create no events"), not "unset".
 *
 * Kept here rather than in authz/ so that the defaults, the shape of an override, and the
 * rule that combines them are all in the file someone opens to change a limit.
 */
export function resolveEffectiveLimits(
  planLimits: EffectiveLimits,
  entRow: UserEntitlementRow,
): EffectiveLimits {
  return {
    maxEventsPerWeek: entRow?.maxEventsPerWeek ?? planLimits.maxEventsPerWeek,
    maxParticipantsPerEvent: entRow?.maxParticipantsPerEvent ?? planLimits.maxParticipantsPerEvent,
    maxGroupsPerEvent: entRow?.maxGroupsPerEvent ?? planLimits.maxGroupsPerEvent,
    // teams-per-owner is a plan decision only — user_entitlements has no column for it.
    maxTeamsPerOwner: planLimits.maxTeamsPerOwner,
  };
}
