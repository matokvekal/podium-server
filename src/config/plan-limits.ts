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
// request path: a user with no user_limits row is a data-integrity fault and raises
// UserLimitsNotFoundError rather than being silently handed the free tier. The previous
// behaviour — a missing table quietly resolving every user to 3 events a week — is exactly
// what this replaces.
//
// ⚠ HISTORICAL NOTE FOR ANYONE MERGING
// An earlier branch modelled the same feature as `user_entitlements` with a per-field
// `override ?? plan ?? default` chain (sql/020-user-entitlements.sql,
// queries/userEntitlements.queries.ts). That approach was superseded: production runs
// `user_limits`, populated by sql/019, and the fallback chain is deliberately gone. The
// FIELD NAMES from that branch (maxEventsPerWeek, …) were kept, because controllers and
// services across the codebase already read them.
//
// It holds no usage counters. What a user HAS used is counted from the real tables at check
// time (countEventsCreatedSince, countJoinedParticipants, countGroupsForEvent,
// countTeamsForOwner), so a stored counter can never drift from what actually happened.
//
// It holds no prices. What a plan costs is a billing concern; see the note atop authz/plans.ts.

import { env } from "./env.js";

/**
 * The four resolved limits, as every caller downstream reads them. A user's row always carries
 * real numbers for all four — there is no "unset" state.
 */
export interface EffectiveLimits {
  /** Rides one organizer may create in a rolling 7 days — not a calendar week. */
  maxEventsPerWeek: number;
  /** Riders on one start list, however they got there: self-joined, added, or imported. */
  maxParticipantsPerEvent: number;
  /** Ride groups within one event. */
  maxGroupsPerEvent: number;
  /** Teams one person may own. */
  maxTeamsPerOwner: number;
}

/**
 * The values a brand-new user's row is created with.
 *
 * Read through a function rather than exported as a frozen constant so that a test can set the
 * env vars and observe the effect, and so the read happens at call time rather than at module
 * load. Callers must not cache the result across a config change.
 */
export function getDefaultUserLimits(): EffectiveLimits {
  return {
    maxEventsPerWeek: env.DEFAULT_EVENTS_PER_WEEK,
    maxParticipantsPerEvent: env.DEFAULT_PARTICIPANTS_PER_EVENT,
    maxGroupsPerEvent: env.DEFAULT_GROUPS_PER_EVENT,
    maxTeamsPerOwner: env.DEFAULT_TEAMS_OWNED,
  };
}
