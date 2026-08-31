// The TEMPLATE used to create a user's limits — and nothing else.
//
// ── The one rule ───────────────────────────────────────────────────────────────────────────
//
// `user_limits` is the single runtime source of truth. Authorization reads that row and only
// that row. The values below are copied into the row ONCE, when it is created (at signup, or
// by the sql/019 backfill), and are never consulted again for that user.
//
//   ENV / config  ──(once, at creation)──>  user_limits  ──(every request)──>  limit check
//
// So changing DEFAULT_EVENTS_PER_WEEK does NOT move a single existing user. Moving an existing
// user is an UPDATE against user_limits — which takes effect on their next request, with no
// deploy. That is the whole point of the design.
//
// ── What this file is NOT ──────────────────────────────────────────────────────────────────
//
// It is NOT a runtime fallback. There is deliberately no `?? DEFAULT_...` anywhere in the
// request path any more: a user with no user_limits row is a data-integrity fault and raises
// UserLimitsNotFoundError rather than being silently handed the free tier. The previous
// behaviour — a missing table quietly resolving every user to 3 events a week — is exactly
// what this replaces.
//
// It holds no usage counters. What a user HAS used is counted from the real tables at check
// time (countEventsCreatedSince, countParticipantsForEvent, countGroupsForEvent,
// countTeamsForOwner), so a stored counter can never drift from what actually happened.
//
// It holds no prices. What a plan costs is a billing concern; see the note atop authz/plans.ts.

import { env } from "./env.js";

/**
 * One user's limits, as authorization consumes them. Every field is a real number: there is no
 * "unset" state, because a row always carries actual values.
 *
 * `teamsPerOwner` is the same thing the DB column calls `teams_owned`; the two names are
 * bridged in exactly one place, mapUserLimitsRow() in queries/userLimits.queries.ts.
 */
export interface UserLimits {
  /** Rides one organizer may create in a rolling 7 days — not a calendar week. */
  eventsPerWeek: number;
  /** Riders on one start list, however they got there: self-joined, added, or imported. */
  participantsPerEvent: number;
  /** Ride groups within one event. */
  groupsPerEvent: number;
  /** Teams one person may own. */
  teamsPerOwner: number;
}

/**
 * The values a brand-new user's row is created with.
 *
 * Read through a function rather than exported as a frozen constant so that a test can set the
 * env vars and observe the effect, and so the read happens at call time rather than at module
 * load. Callers must not cache the result across a config change.
 */
export function getDefaultUserLimits(): UserLimits {
  return {
    eventsPerWeek: env.DEFAULT_EVENTS_PER_WEEK,
    participantsPerEvent: env.DEFAULT_PARTICIPANTS_PER_EVENT,
    groupsPerEvent: env.DEFAULT_GROUPS_PER_EVENT,
    teamsPerOwner: env.DEFAULT_TEAMS_OWNED,
  };
}
