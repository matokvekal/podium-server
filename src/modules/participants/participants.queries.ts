// SQL for event_participants beyond the frozen join/upsert path — that one stays in
// event.queries.ts since it predates this module and the Android contract depends on it.
// Manual add, edit, delete, approve/reject and listing all live here.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract. Nothing here
// touches it.

import { execute, query, queryOne } from "../../db/pool.js";
import type { EventParticipant, RegistrationStatus } from "../../db/types.js";
import { mapParticipant } from "../events/event.queries.js";

interface EventParticipantRow {
  id: number;
  event_id: string;
  user_id: number | null;
  bib: string | null;
  joined_at: Date;
  left_at: Date | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  category: string | null;
  registration_status: RegistrationStatus;
  attendance_status: EventParticipant["attendanceStatus"];
  result_status: EventParticipant["resultStatus"];
  finished_at: Date | null;
  finish_position: number | null;
  /** Only present on the joined query below — see the same field on event.queries.ts's
   *  EventParticipantRow, which mapParticipant actually reads. */
  display_name?: string | null;
  avatar_url?: string | null;
}

/**
 * Default roster: a rider who left drops off automatically (left_at IS NULL). This is the one
 * query behind both GET /:eventId/participants (via participants.service.ts) and GET
 * /:eventId/live's rider names (via event.service.ts's getLiveRiders) — so the name/avatar
 * resolution below covers both response shapes from a single place.
 *
 * display_name: a real account's (ep.user_id set) nickname wins, else trimmed "first last",
 * else ep.name as a last resort (normally null for a real account, but harmless to include).
 * For a manual/account-less entry (user_id null) the LEFT JOIN makes every u.* column null, so
 * this collapses to plain ep.name — unaffected by this change. avatar_url is the real
 * account's users.avatar_url, always null for a manual entry.
 */
export async function selectParticipantsForEvent(eventId: string): Promise<EventParticipant[]> {
  const rows = await query<EventParticipantRow>(
    `SELECT ep.*,
        COALESCE(
          NULLIF(TRIM(u.nickname), ''),
          NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
          ep.name
        ) AS display_name,
        u.avatar_url
       FROM event_participants ep
       LEFT JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = $1 AND ep.left_at IS NULL
      ORDER BY ep.joined_at ASC`,
    [eventId],
  );
  return rows.map(mapParticipant);
}

export async function selectParticipantByIdForEvent(
  participantId: number,
  eventId: string,
): Promise<EventParticipant | null> {
  const row = await queryOne<EventParticipantRow>(
    "SELECT * FROM event_participants WHERE id = $1 AND event_id = $2",
    [participantId, eventId],
  );
  return row ? mapParticipant(row) : null;
}

/** Manual add (organizer entry, no linked account) — confirmed immediately, no approval step. */
export async function insertManualParticipant(
  eventId: string,
  input: {
    name: string;
    email: string | null;
    phone: string | null;
    category: string | null;
    bib: string | null;
  },
): Promise<EventParticipant> {
  const row = await queryOne<EventParticipantRow>(
    `INSERT INTO event_participants (event_id, name, email, phone, category, bib, registration_status)
      VALUES ($1, $2, $3, $4, $5, $6, 'approved')
      RETURNING *`,
    [eventId, input.name, input.email, input.phone, input.category, input.bib],
  );
  if (!row) throw new Error("insertManualParticipant returned no row");
  return mapParticipant(row);
}

/** Partial update — COALESCE keeps the stored value for anything the caller left out. */
export async function updateParticipant(
  participantId: number,
  eventId: string,
  input: { name?: string; email?: string; phone?: string; category?: string; bib?: string },
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    `UPDATE event_participants
        SET name = COALESCE($3, name),
            email = COALESCE($4, email),
            phone = COALESCE($5, phone),
            category = COALESCE($6, category),
            bib = COALESCE($7, bib)
      WHERE id = $1 AND event_id = $2
      RETURNING *`,
    [
      participantId,
      eventId,
      input.name ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.category ?? null,
      input.bib ?? null,
    ],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

export async function deleteParticipant(participantId: number, eventId: string): Promise<boolean> {
  const affected = await execute("DELETE FROM event_participants WHERE id = $1 AND event_id = $2", [
    participantId,
    eventId,
  ]);
  return affected > 0;
}

export async function updateRegistrationStatus(
  participantId: number,
  eventId: string,
  status: RegistrationStatus,
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    `UPDATE event_participants SET registration_status = $3
      WHERE id = $1 AND event_id = $2
      RETURNING *`,
    [participantId, eventId, status],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}
