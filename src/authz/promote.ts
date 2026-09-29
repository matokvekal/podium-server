// PROMOTE (sql/053): an otherwise normal, fully visible event whose REGISTRATION is handled by
// the organizers outside El Nino, until the admin switches it off.
//
//   canManagePromote     — who may switch PROMOTE on/off (today: the System Admin only)
//   assertRegistrationOpen — refuses self-registration (join) while PROMOTE is on
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
 * PROMOTE closes REGISTRATION only: the ride stays a normal, fully viewable event, but nobody
 * may join it through El Nino while promoteOnly is true (registration happens with the
 * organizers, off-platform). Applies to everyone who would self-register, System Admin included —
 * to test joining, switch PROMOTE off. A normal event (promoteOnly false) is never affected.
 */
export function assertRegistrationOpen(event: Event): void {
  if (!event.promoteOnly) return;
  throw new ApiError(403, "Registration is through the organizers (PROMOTE_REGISTRATION)");
}
