// The single INSERT into analytics_events. Kept dumb on purpose: it does one write and lets
// errors propagate — audit.service.ts is the layer that swallows them so the caller is never
// affected. See sql/031-analytics-events.sql.

import { execute } from "../db/pool.js";
import type { AuditEvent } from "./audit.types.js";

export async function insertAnalyticsEvent(event: AuditEvent): Promise<void> {
  await execute(
    `INSERT INTO analytics_events
        (event_type, user_id, ride_id, route_id, country_code, ride_visibility, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.type,
      event.userId ?? null,
      event.rideId ?? null,
      event.routeId ?? null,
      // 2-letter, stored uppercase — same convention as events.country / country_code elsewhere.
      event.countryCode ? event.countryCode.toUpperCase() : null,
      event.rideVisibility ?? null,
      JSON.stringify(event.details ?? {}),
    ],
  );
}
