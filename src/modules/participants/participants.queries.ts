// SQL for event_participants beyond the frozen join/upsert path — that one stays in
// event.queries.ts since it predates this module and the Android contract depends on it.
// Manual add, edit, delete, approve/reject and listing all live here.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract. Nothing here
// touches it.

import { execute, query, queryOne, withTransaction } from "../../db/pool.js";
import type {
  AttendanceStatus,
  EventParticipant,
  RegistrationStatus,
  ResultStatus,
} from "../../db/types.js";
import { mapParticipant, PARTICIPANT_DISPLAY_COLUMNS } from "../events/event.queries.js";

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
  team: string | null;
  country_code: string | null;
  group_id: number | null;
  registration_status: RegistrationStatus;
  attendance_status: EventParticipant["attendanceStatus"];
  result_status: EventParticipant["resultStatus"];
  finished_at: Date | null;
  finish_position: number | null;
<<<<<<< HEAD
  /** Only present on the joined query below — see the same field on event.queries.ts's
   *  EventParticipantRow, which mapParticipant actually reads. */
=======
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
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
<<<<<<< HEAD
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
=======
    `SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM event_participants ep
       LEFT JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = $1
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
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
    `SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM event_participants ep
       LEFT JOIN users u ON u.id = ep.user_id
      WHERE ep.id = $1 AND ep.event_id = $2`,
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
    team: string | null;
    countryCode: string | null;
  },
): Promise<EventParticipant> {
  const row = await queryOne<EventParticipantRow>(
    `INSERT INTO event_participants
        (event_id, name, email, phone, category, bib, team, country_code, registration_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')
      RETURNING *`,
    [
      eventId,
      input.name,
      input.email,
      input.phone,
      input.category,
      input.bib,
      input.team,
      input.countryCode,
    ],
  );
  if (!row) throw new Error("insertManualParticipant returned no row");
  return mapParticipant(row);
}

/**
 * All-or-nothing import. withTransaction is the point: a spreadsheet that fails on row 41
 * must leave the start list exactly as it was, not 40 riders in.
 */
export async function insertManualParticipants(
  eventId: string,
  rows: {
    name: string;
    email: string | null;
    phone: string | null;
    category: string | null;
    bib: string | null;
    team: string | null;
    countryCode: string | null;
  }[],
): Promise<EventParticipant[]> {
  return withTransaction(async (tx) => {
    const created: EventParticipant[] = [];
    for (const input of rows) {
      const row = await tx.queryOne<EventParticipantRow>(
        `INSERT INTO event_participants
            (event_id, name, email, phone, category, bib, team, country_code, registration_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')
          RETURNING *`,
        [
          eventId,
          input.name,
          input.email,
          input.phone,
          input.category,
          input.bib,
          input.team,
          input.countryCode,
        ],
      );
      if (!row) throw new Error("insertManualParticipants returned no row");
      created.push(mapParticipant(row));
    }
    return created;
  });
}

/** Partial update — COALESCE keeps the stored value for anything the caller left out. */
export async function updateParticipant(
  participantId: number,
  eventId: string,
  input: {
    name?: string;
    email?: string;
    phone?: string;
    category?: string;
    bib?: string;
    team?: string;
    countryCode?: string;
  },
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    // The CTE re-joins `users` on the way out: a bare RETURNING * would send back a NULL name
    // for a rider who joined through the app, and the client swaps this row straight into its
    // list — so the name it just displayed would blank out on every edit.
    `WITH updated AS (
       UPDATE event_participants
          SET name = COALESCE($3, name),
              email = COALESCE($4, email),
              phone = COALESCE($5, phone),
              category = COALESCE($6, category),
              bib = COALESCE($7, bib),
              team = COALESCE($8, team),
              country_code = COALESCE($9, country_code)
        WHERE id = $1 AND event_id = $2
        RETURNING *
     )
     SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM updated ep
       LEFT JOIN users u ON u.id = ep.user_id`,
    [
      participantId,
      eventId,
      input.name ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.category ?? null,
      input.bib ?? null,
      input.team ?? null,
      input.countryCode ?? null,
    ],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

/**
 * Attendance and result are separate statements from each other and from registration —
 * three axes, three writes. Both re-join `users` on the way out for the same reason
 * updateParticipant does: the client swaps the row it gets back straight into its list.
 */
export async function updateAttendanceStatus(
  participantId: number,
  eventId: string,
  status: AttendanceStatus,
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    `WITH updated AS (
       UPDATE event_participants SET attendance_status = $3
        WHERE id = $1 AND event_id = $2
        RETURNING *
     )
     SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM updated ep
       LEFT JOIN users u ON u.id = ep.user_id`,
    [participantId, eventId, status],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

/**
 * finished_at and finish_position are cleared whenever the status moves off "finished" — a
 * rider corrected from finished to DNF must not keep a finish time, or they stay in the
 * results ranking forever.
 */
export async function updateResult(
  participantId: number,
  eventId: string,
  input: { status: ResultStatus; finishedAt: Date | null; finishPosition: number | null },
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    `WITH updated AS (
       UPDATE event_participants
          SET result_status = $3,
              finished_at = $4,
              finish_position = $5
        WHERE id = $1 AND event_id = $2
        RETURNING *
     )
     SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM updated ep
       LEFT JOIN users u ON u.id = ep.user_id`,
    [participantId, eventId, input.status, input.finishedAt, input.finishPosition],
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
    // Same re-join as updateParticipant — approving a rider must not blank out their name.
    `WITH updated AS (
       UPDATE event_participants SET registration_status = $3
        WHERE id = $1 AND event_id = $2
        RETURNING *
     )
     SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM updated ep
       LEFT JOIN users u ON u.id = ep.user_id`,
    [participantId, eventId, status],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}
