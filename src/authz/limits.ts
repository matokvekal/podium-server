// Limit checks, driven by the caller's resolved entitlements.
//
// Replaces the old lib/plan-limits.ts, whose limits were a hard-coded constant. Nothing here
// knows what a plan costs or which one the caller is on — it asks for the resolved limit and
// compares. Adding a tier changes plans.ts and nothing in this file.

import { ApiError } from "../lib/api-error.js";
import type { Actor } from "./policy.js";

/**
 * 409, not 403: the caller is permitted to do this, they have run out of allowance. Different
 * status, different client screen ("upgrade", not "not yours"), and the PLAN_LIMIT_* code is
 * what the client keys an upgrade prompt on rather than parsing English.
 *
 * `limit` and `current` are in the message on purpose — a client showing "3 of 3 rides used"
 * should not have to make a second call to find out.
 */
function overLimit(code: string, message: string, current: number, limit: number): never {
  throw new ApiError(409, `${message} — used ${current} of ${limit} (PLAN_LIMIT_${code})`);
}

export function assertWithinEventsPerWeek(actor: Actor, current: number): void {
  const limit = actor.entitlements.limits.maxEventsPerWeek;
  if (current >= limit) {
    overLimit("EVENTS_PER_WEEK", "You have reached your rides for this week", current, limit);
  }
}

/**
 * `adding` rather than a bare count, because an import adds many at once and must be refused
 * as a whole — taking the first 30 rows of a 60-row spreadsheet leaves the organizer worse off
 * than a clean refusal.
 */
export function assertWithinParticipantLimit(actor: Actor, current: number, adding: number): void {
  const limit = actor.entitlements.limits.maxParticipantsPerEvent;
  if (current + adding > limit) {
    overLimit("PARTICIPANTS", "This ride is at its rider limit", current, limit);
  }
}

export function assertWithinGroupLimit(actor: Actor, current: number): void {
  const limit = actor.entitlements.limits.maxGroupsPerEvent;
  if (current >= limit) {
    overLimit("GROUPS", "This ride is at its ride-group limit", current, limit);
  }
}

export function assertWithinTeamLimit(actor: Actor, current: number): void {
  const limit = actor.entitlements.limits.maxTeamsPerOwner;
  if (current >= limit) {
    overLimit("TEAMS", "You have reached your team limit", current, limit);
  }
}
