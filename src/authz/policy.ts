// The policy. Every authorization decision in the product is one of the functions below.
//
// PURE AND I/O-FREE ON PURPOSE. It takes an already-resolved actor and an already-resolved
// context and returns booleans. No database, no imports from modules/, no awaits. That is what
// makes the whole permission system readable in one sitting and testable without a server.
//
// The rule from AUTHORIZATION.md: nothing outside src/authz/ asks "is this user premium".
// Callers ask for a capability; this decides.

import type { Event, EventStatus, EventVisibility } from "../db/types.js";
import type { AccountCapability, EventCapability, TeamCapability } from "./capabilities.js";
import type { Entitlements } from "./entitlements.js";

/** Layer 2. `guest` is derived from the absence of an identity and never stored. */
export type GlobalRole = "guest" | "RIDER" | "COMMISSAIRE";

/** Layer 3, the role half. Mirrors event_members.role. */
export type EventRole = "owner" | "operator" | "viewer" | null;

/** Layer 3, the participation half. Deliberately NOT merged with the role. */
export type Participation = "none" | "pending" | "approved" | "rejected";

/** Layers 1, 2 and 4, resolved once per request. */
export interface Actor {
  userId: number | null;
  globalRole: GlobalRole;
  entitlements: Entitlements;
}

/** Everything about one event that the policy needs, and nothing else. */
export interface EventContext {
  event: Event;
  role: EventRole;
  participation: Participation;
}

export interface TeamContext {
  isOwner: boolean;
  /** An approved member. Pending members can see the team, not run it. */
  isMember: boolean;
  /** Any row at all, including waiting_approval — enough to see what you asked to join. */
  hasRow: boolean;
}

const isSignedIn = (actor: Actor): boolean => actor.userId !== null;

/** Owner or co-organizer. The two differ only where noted below. */
function isStaff(ctx: EventContext): boolean {
  return ctx.role === "owner" || ctx.role === "operator";
}

/** On the start list, whether or not approval was ever required. */
function isRiding(ctx: EventContext): boolean {
  return ctx.participation === "approved";
}

// ---------------------------------------------------------------------------------------
// Layer 5 — visibility. "Does this ride exist for you", answered before anything else.
// ---------------------------------------------------------------------------------------

function canSeeEventExists(actor: Actor, ctx: EventContext): boolean {
  if (isStaff(ctx)) return true;
  // A participation row is a key in its own right: the whole closed-ride story is that an
  // organizer shares a link, riders ask to join, and an approved rider then sees the ride.
  if (ctx.participation !== "none" && ctx.participation !== "rejected") return true;

  const visibility: EventVisibility = ctx.event.visibility;
  if (visibility === "public") return true;
  if (visibility === "registered") return isSignedIn(actor);
  return false; // private, and no relationship → the caller gets 404, never 403
}

/**
 * How much of a permitted viewer's ride is filled in.
 *
 * `show_event_info` is a *public browsing* switch and defaults to TRUE, so it has no say over
 * staff or a rider who is in. A rider still waiting on a PRIVATE ride sees none of it — that
 * is the point of approval. On a public or registered-only ride they are no worse off than any
 * other browser, which is why this keys on visibility rather than on participation alone.
 */
function canSeeDetails(actor: Actor, ctx: EventContext): boolean {
  if (isStaff(ctx) || isRiding(ctx)) return true;
  if (ctx.event.visibility === "private") return false;
  return ctx.event.showEventInfo;
}

// ---------------------------------------------------------------------------------------
// Event capabilities
// ---------------------------------------------------------------------------------------

const FINAL_STATUSES: EventStatus[] = ["finished", "cancelled"];

export function canEvent(
  actor: Actor,
  capability: EventCapability,
  ctx: EventContext,
): boolean {
  // Nothing is visible on an event you cannot see at all.
  if (!canSeeEventExists(actor, ctx)) return false;

  switch (capability) {
    case "event:view":
      return true;

    case "event:view_details":
      return canSeeDetails(actor, ctx);

    case "event:view_route":
      // Stricter than details: a closed ride's track is the organizer's to hand out, and
      // asking to join is not being handed it.
      if (isStaff(ctx) || isRiding(ctx)) return true;
      if (ctx.participation === "pending") return false;
      return ctx.event.visibility !== "private" && ctx.event.showRoute;

    case "event:view_participants":
      if (isStaff(ctx)) return true;
      if (ctx.participation === "pending") return false;
      if (!ctx.event.showParticipants) return false;
      // Riders on the list may see the list; strangers only on a ride open to them.
      return isRiding(ctx) || ctx.event.visibility !== "private";

    case "event:view_live":
      if (isStaff(ctx)) return true;
      if (ctx.participation === "pending") return false;
      // A rider always gets the live endpoint so they can see THEMSELVES; the flag governs
      // whether the response may include anyone else. That split lives in the live service.
      if (isRiding(ctx)) return true;
      return ctx.event.visibility !== "private" && ctx.event.showLiveLocations;

    case "event:view_results":
      if (isStaff(ctx) || isRiding(ctx)) return true;
      if (ctx.participation === "pending") return false;
      return ctx.event.visibility !== "private" && ctx.event.showResults;

    case "event:view_history":
      // Stricter default than results (FALSE vs TRUE): where someone rode is more revealing
      // than whether they finished — it is their route home.
      if (ctx.role === "owner") return true;
      if (ctx.participation === "pending") return false;
      return ctx.event.showHistoryLocations;

    case "event:join":
      if (!isSignedIn(actor)) return false;
      if (isStaff(ctx)) return false; // organizers are not on their own start list by joining
      if (ctx.participation === "rejected") return false;
      return !FINAL_STATUSES.includes(ctx.event.status);

    case "event:edit":
      // Details are frozen once the ride is out on the road. The show_* flags are NOT details
      // and stay editable — see the separate carve-out in the event service.
      return isStaff(ctx) && !FINAL_STATUSES.includes(ctx.event.status) && ctx.event.status !== "live";

    case "event:change_status":
    case "event:manage_participants":
    case "event:manage_groups":
      return isStaff(ctx);

    case "event:manage_route":
      return isStaff(ctx) && !FINAL_STATUSES.includes(ctx.event.status);

    case "event:delete":
      // Cancelling a ride is the owner's alone — an operator helps run it, not end it.
      return ctx.role === "owner";

    case "event:manage_members":
      // Co-organizers are a Club-tier feature, and only the owner may appoint them.
      return ctx.role === "owner" && actor.entitlements.features.has("co_organizers");

    default: {
      // Exhaustiveness: adding a capability without a rule fails to compile rather than
      // silently defaulting to allowed.
      const never: never = capability;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Account capabilities
// ---------------------------------------------------------------------------------------

export function canAccount(actor: Actor, capability: AccountCapability): boolean {
  if (!isSignedIn(actor)) return false; // every account capability needs an identity

  switch (capability) {
    case "team:create":
    case "route:create":
    case "route:publish":
      // Free for everyone: participation and social activity stay free to maximise adoption.
      // Scale is governed by limits, which are checked separately at the point of creation —
      // a capability answers "may you", a limit answers "how many more".
      return true;

    case "event:create":
      // NOT free: ride creation is opened deliberately, one account at a time, until a
      // self-serve path exists. A paid organizer plan includes `create_events`; otherwise it
      // is a single manual feature grant. Scale on top of that is still a limit, checked at
      // the point of creation.
      return actor.entitlements.features.has("create_events");

    case "event:create_private":
      // The first sellable capability, and it still presupposes being allowed to create a
      // ride at all. `private_events` may come from a plan OR a consumable one-time credit —
      // the policy does not care which, and neither does the caller.
      return (
        actor.entitlements.features.has("create_events") &&
        actor.entitlements.features.has("private_events")
      );

    default: {
      const never: never = capability;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Team capabilities
// ---------------------------------------------------------------------------------------

export function canTeam(actor: Actor, capability: TeamCapability, ctx: TeamContext): boolean {
  if (!isSignedIn(actor)) return false;

  switch (capability) {
    case "team:view":
      // A club's membership is not a browse surface: no guest view, and a stranger gets 404.
      return ctx.isOwner || ctx.hasRow;
    case "team:manage":
    case "team:manage_members":
      return ctx.isOwner;
    case "team:join":
      return !ctx.isOwner && !ctx.hasRow;
    default: {
      const never: never = capability;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Bulk evaluation — what the client is actually sent
// ---------------------------------------------------------------------------------------

export function eventCapabilitiesFor(
  actor: Actor,
  ctx: EventContext,
  all: readonly EventCapability[],
): EventCapability[] {
  return all.filter((capability) => canEvent(actor, capability, ctx));
}

export function accountCapabilitiesFor(
  actor: Actor,
  all: readonly AccountCapability[],
): AccountCapability[] {
  return all.filter((capability) => canAccount(actor, capability));
}
