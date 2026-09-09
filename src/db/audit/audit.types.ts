import type { AuditEventType } from "./audit.constants.js";

export type { AuditEventType };

/**
 * One analytics event, as a caller hands it to trackAuditEvent(). Every field but `type` is
 * optional — a business action records whatever dimensions it actually has and nothing more.
 *
 * The first-class dimensions map straight to columns (see sql/031-analytics-events.sql):
 *   userId          -> user_id         (BIGINT — users.id)
 *   rideId          -> ride_id         (UUID   — events.id, kept as a string here)
 *   routeId         -> route_id        (BIGINT — routes.id)
 *   countryCode     -> country_code    (2-letter, uppercased on write)
 *   rideVisibility  -> ride_visibility ('public' | 'registered' | 'private')
 *
 * `details` is for anything that does not deserve a permanent column yet (a provider name, a
 * route source). Do NOT hide a first-class dimension in here.
 */
export interface AuditEvent {
  type: AuditEventType;
  userId?: number | null;
  rideId?: string | null;
  routeId?: number | null;
  countryCode?: string | null;
  rideVisibility?: string | null;
  details?: Record<string, unknown>;
}
