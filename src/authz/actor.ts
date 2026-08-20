// Resolving the caller (layers 1, 2 and 4) and one event's context (layer 3).
//
// This is the only file in src/authz/ that touches the database. policy.ts stays pure; these
// functions turn rows into the plain inputs it takes.

import { queryOne } from "../db/pool.js";
import { ApiError } from "../lib/api-error.js";
import type { Event } from "../db/types.js";
import { ANONYMOUS_ENTITLEMENTS, resolveEntitlements } from "./entitlements.js";
import type { Actor, EventContext, EventRole, GlobalRole, Participation } from "./policy.js";

/**
 * Layers 1, 2 and 4 in one place. One query for the role, one for the grants — resolved once
 * per request and passed down, never re-fetched per capability check.
 */
export async function buildActor(userId: number | null): Promise<Actor> {
  if (userId === null) {
    return { userId: null, globalRole: "guest", entitlements: ANONYMOUS_ENTITLEMENTS };
  }

  const [row, entitlements] = await Promise.all([
    queryOne<{ role: GlobalRole }>("SELECT role FROM users WHERE id = $1", [userId]),
    resolveEntitlements(userId),
  ]);

  return {
    userId,
    // A token for a user row that no longer exists degrades to RIDER rather than throwing;
    // requireAuth and the handlers already deal with a missing user properly.
    globalRole: row?.role ?? "RIDER",
    entitlements,
  };
}

/**
 * Layer 3 for one event: the role and the participation, kept separate. A person who both
 * organizes and rides has both, and merging them would make that inexpressible.
 */
export async function buildEventContext(event: Event, userId: number | null): Promise<EventContext> {
  if (userId === null) return { event, role: null, participation: "none" };

  const [memberRow, participantRow] = await Promise.all([
    queryOne<{ role: EventRole }>(
      "SELECT role FROM event_members WHERE event_id = $1 AND user_id = $2",
      [event.id, userId],
    ),
    queryOne<{ registration_status: string }>(
      "SELECT registration_status FROM event_participants WHERE event_id = $1 AND user_id = $2",
      [event.id, userId],
    ),
  ]);

  // events.owner_id is still the source of truth for ownership; the event_members row is the
  // extensible form of it (and the only way to express an operator). Falling back to owner_id
  // means an event whose member row never got written is not suddenly unmanageable.
  const role: EventRole =
    memberRow?.role ?? (event.ownerId !== null && event.ownerId === userId ? "owner" : null);

  return { event, role, participation: toParticipation(participantRow?.registration_status) };
}

function toParticipation(status: string | undefined): Participation {
  switch (status) {
    // "registered" is the auto-approved case: an event that needs no approval never moves
    // anyone past it, so it has to count as being in.
    case "registered":
    case "approved":
      return "approved";
    case "waiting_approval":
      return "pending";
    case "rejected":
      return "rejected";
    default:
      return "none";
  }
}

/**
 * The refusal vocabulary, in one place so every endpoint answers the same way.
 *
 * 404 rather than 403 when the resource should not be admitted to exist: a private ride's id
 * is shared as a link or QR and IS the secret, so confirming it is real leaks the thing the
 * secret protects.
 */
export function denyNotFound(what = "Event"): never {
  throw new ApiError(404, `${what} not found`);
}

export function denyForbidden(message: string): never {
  throw new ApiError(403, message);
}

/**
 * 402, distinct from the 409 a limit raises. "This is not part of your plan" and "you have hit
 * your ceiling" lead to different screens and different purchases — buy this vs. upgrade.
 */
export function denyFeature(feature: string, message: string): never {
  throw new ApiError(402, `${message} (PLAN_FEATURE_${feature.toUpperCase()})`);
}
