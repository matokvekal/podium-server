// The single source of truth for DEFAULT limits — what a brand-new user, on no plan, may do.
//
// ── Where a limit actually comes from ──────────────────────────────────────────────────────
//
//   1. user_limits.<column>   a per-user override (sql/018-user-limits.sql). NULL = inherit.
//   2. the user's plan        src/authz/plans.ts — a plan is granted by an entitlement_grants
//                             row, so nobody is "on" a paid plan without one.
//   3. DEFAULT_PLAN_LIMITS    below. These ARE the free plan's numbers: PLANS.free reads them,
//                             so changing a number here changes it for every free user with no
//                             override, with no other edit anywhere.
//
//   effective = override ?? plan limit
//
// ── What this file is NOT ──────────────────────────────────────────────────────────────────
//
// It holds no usage counters. What a user HAS used is counted from the real tables at check
// time (countEventsCreatedSince, countParticipantsForEvent, countGroupsForEvent,
// countTeamsForOwner), so a stored counter can never drift from what actually happened.
//
// It holds no prices. What a plan costs is a billing concern; see the note at the top of
// src/authz/plans.ts.

export const DEFAULT_PLAN_LIMITS = {
  /** Rides one organizer may create in a rolling 7 days — not a calendar week. */
  eventsPerWeek: 3,
  /** Riders on one start list, however they got there: self-joined, added, or imported. */
  participantsPerEvent: 50,
  /** Ride groups within one event. */
  groupsPerEvent: 2,
  /** Teams one person may own. */
  teamsOwned: 2,
} as const;

/**
 * One user_limits row as the database returns it, or null when the user has none.
 *
 * Every column is nullable and NULL means INHERIT, not zero — see sql/018-user-limits.sql.
 * A missing row and a row of all NULLs are therefore the same answer.
 */
export type UserLimitDbRow = Partial<{
  events_per_week: number | null;
  participants_per_event: number | null;
  teams_owned: number | null;
  groups_per_event: number | null;
}> | null;

/**
 * An override row folded onto the defaults. Used where there is no plan in play — the
 * defaults ARE the free plan, so this is the free-tier answer.
 *
 * For the full resolution, which layers a plan in between, see resolveEffectiveLimits below.
 */
export function normalizeUserLimitValues(row: UserLimitDbRow): {
  eventsPerWeek: number;
  participantsPerEvent: number;
  groupsPerEvent: number;
  teamsOwned: number;
} {
  return {
    eventsPerWeek: row?.events_per_week ?? DEFAULT_PLAN_LIMITS.eventsPerWeek,
    participantsPerEvent: row?.participants_per_event ?? DEFAULT_PLAN_LIMITS.participantsPerEvent,
    groupsPerEvent: row?.groups_per_event ?? DEFAULT_PLAN_LIMITS.groupsPerEvent,
    teamsOwned: row?.teams_owned ?? DEFAULT_PLAN_LIMITS.teamsOwned,
  };
}

export const DEFAULT_FREE_PLAN_LIMITS = {
  eventsPerWeek: DEFAULT_PLAN_LIMITS.eventsPerWeek,
  participantsPerEvent: DEFAULT_PLAN_LIMITS.participantsPerEvent,
  groupsPerEvent: DEFAULT_PLAN_LIMITS.groupsPerEvent,
  teamsPerOwner: DEFAULT_PLAN_LIMITS.teamsOwned,
} as const;

/**
 * The one function that answers "what may this user actually do".
 *
 * `planLimits` is what the user's plan allows (PLANS.free's limits when they hold no plan
 * grant, which is DEFAULT_PLAN_LIMITS). `row` is their override. A non-NULL override column
 * wins outright — including a LOWER number, so a limit can be tightened for one account as
 * well as raised. A NULL column, or no row at all, inherits.
 *
 * Kept here rather than in authz/ so that the defaults, the shape of an override, and the
 * rule that combines them are all in the file someone opens to change a limit.
 */
export function resolveEffectiveLimits(
  planLimits: {
    eventsPerWeek: number;
    participantsPerEvent: number;
    groupsPerEvent: number;
    teamsPerOwner: number;
  },
  row: UserLimitDbRow,
): {
  eventsPerWeek: number;
  participantsPerEvent: number;
  groupsPerEvent: number;
  teamsPerOwner: number;
} {
  return {
    eventsPerWeek: row?.events_per_week ?? planLimits.eventsPerWeek,
    participantsPerEvent: row?.participants_per_event ?? planLimits.participantsPerEvent,
    groupsPerEvent: row?.groups_per_event ?? planLimits.groupsPerEvent,
    // The DB column is teams_owned; PlanLimits calls the same thing teamsPerOwner.
    teamsPerOwner: row?.teams_owned ?? planLimits.teamsPerOwner,
  };
}
