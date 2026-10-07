// SQL for the System Admin's ride rider-cap table on /admin2026 — sql/060's
// events.max_participants. Read and written only by routes/adminRides.routes.ts.

import { query, queryOne } from "../db/pool.js";
import type { EventStatus } from "../db/types.js";

export interface AdminRideRow {
  id: string;
  code: string;
  name: string;
  starts_at: Date;
  status: EventStatus;
  owner_id: number | null;
  owner_name: string | null;
  /** The owner's account cap (user_limits.participants_per_event); null for an ownerless ride. */
  owner_limit: number | null;
  /** The per-ride override; null = the owner's account cap applies. */
  max_participants: number | null;
  /** Approved + still-pending, not left — authz/participant-capacity.ts's rule. */
  participant_count: string;
}

const ADMIN_RIDE_COLUMNS = `
  e.id, e.code, e.name, e.starts_at, e.status, e.owner_id,
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    u.nickname
  ) AS owner_name,
  ul.participants_per_event AS owner_limit,
  e.max_participants,
  (SELECT COUNT(*) FROM event_participants ep
    WHERE ep.event_id = e.id
      AND ep.left_at IS NULL
      AND ep.registration_status IN ('registered', 'approved', 'waiting_approval'))::text
    AS participant_count`;

const ADMIN_RIDE_FROM = `
  FROM events e
  LEFT JOIN users u ON u.id = e.owner_id
  LEFT JOIN user_limits ul ON ul.user_id = e.owner_id`;

/**
 * Rides still to come. The status / ends_at half is the app's own "upcoming" bucket
 * (event.queries.ts, the public list's `$5 = 'upcoming'`); starts_at in the future is added on
 * top so a ride whose date passed but was never marked finished does not show. A ride with no
 * date is not "upcoming" either.
 */
export async function selectUpcomingRidesForAdmin(): Promise<AdminRideRow[]> {
  return query<AdminRideRow>(
    `SELECT ${ADMIN_RIDE_COLUMNS}
     ${ADMIN_RIDE_FROM}
     WHERE e.status IN ('published', 'registration_open', 'ready')
       AND (e.ends_at IS NULL OR e.ends_at >= NOW())
       AND e.starts_at IS NOT NULL
       AND e.starts_at >= NOW()
     ORDER BY e.starts_at ASC, e.created_at DESC`,
  );
}

/** Sets (or, with null, clears) one ride's override. Null when there is no such ride. */
export async function updateRideMaxParticipants(
  eventId: string,
  maxParticipants: number | null,
): Promise<AdminRideRow | null> {
  const updated = await queryOne<{ id: string }>(
    "UPDATE events SET max_participants = $2, updated_at = NOW() WHERE id = $1 RETURNING id",
    [eventId, maxParticipants],
  );
  if (!updated) return null;
  return queryOne<AdminRideRow>(
    `SELECT ${ADMIN_RIDE_COLUMNS}
     ${ADMIN_RIDE_FROM}
     WHERE e.id = $1`,
    [eventId],
  );
}
