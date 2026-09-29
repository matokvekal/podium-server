// PROMOTE (sql/053): an event that is shown as a normal card but is closed to everyone except
// the System Admin and its own owner, until the admin switches it off.
//
// The one place both questions are answered:
//   canManagePromote  — who may switch PROMOTE on/off (today: the System Admin only)
//   assertCanEnterPromoteEvent — who may go past the card (join, detail, participants, ...)
//
// To let more admins use PROMOTE later, change canManagePromote and nothing else.

import { isAdminEmail } from "../adminAnalytics/adminAnalytics.auth.js";
import type { Event } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { selectUserEmails } from "../queries/user.queries.js";

/** The System Admin — the same identity check that gates /admin2026 (env ADMIN_ANALYTICS_EMAILS). */
export async function canManagePromote(userId: number | null | undefined): Promise<boolean> {
  if (userId == null) return false;
  return isAdminEmail(await selectUserEmails(userId));
}

/**
 * Throws 403 unless the event is open to this viewer. A normal event (promoteOnly false) returns
 * immediately with no lookup, so nothing about existing events changes. The owner keeps access
 * to their own ride; everyone else needs to be the System Admin.
 */
export async function assertCanEnterPromoteEvent(
  event: Event,
  userId: number | null | undefined,
): Promise<void> {
  if (!event.promoteOnly) return;
  if (userId != null && event.ownerId === userId) return;
  if (await canManagePromote(userId)) return;
  throw new ApiError(403, "This ride is not open yet (PROMOTE_LOCKED)");
}
