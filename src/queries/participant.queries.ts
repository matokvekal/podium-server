// SQL for event_participants beyond the frozen join/upsert path — that one stays in
// event.queries.ts since it predates this module and the Android contract depends on it.
// Manual add, edit, delete, approve/reject and listing all live here.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract. Nothing here
// touches it.

import { execute, query, queryOne, withTransaction } from "../db/pool.js";
import type {
  AttendanceStatus,
  EventParticipant,
  RegistrationStatus,
  ResultStatus,
} from "../db/types.js";
import type { LatLng } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import {
  isMissingColumnError,
  mapParticipant,
  PARTICIPANT_DISPLAY_COLUMNS,
} from "./event.queries.js";

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
  attendance_source?: EventParticipant["attendanceSource"];
  result_status: EventParticipant["resultStatus"];
  finished_at: Date | null;
  finish_position: number | null;
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_type?: string | null;
  avatar_value?: string | null;
}

export async function selectParticipantsForEvent(eventId: string): Promise<EventParticipant[]> {
  const rows = await query<EventParticipantRow>(
    `SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM event_participants ep
       LEFT JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = $1
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
 *
 * This is the ORGANIZER's write, so it stamps attendance_source = 'manual' — for every status,
 * `unknown` included. That last part is deliberate: un-ticking a rider an automatic check-in had
 * marked must stick, and the automatic write only ever fires on `unknown` + a NULL source
 * (markArrivedAutomatically), so a 'manual' stamp on an `unknown` row is what keeps the app from
 * ticking that rider straight back.
 *
 * ⚠ Retries WITHOUT the source when sql/040 has not run. Ticking riders off at the start is the
 * one thing an organizer does on the morning of a ride, and it must not start failing on a
 * database that has not reached this migration yet.
 */
export async function updateAttendanceStatus(
  participantId: number,
  eventId: string,
  status: AttendanceStatus,
): Promise<EventParticipant | null> {
  const write = (setSource: boolean) =>
    query<EventParticipantRow>(
      `WITH updated AS (
         UPDATE event_participants
            SET attendance_status = $3${setSource ? ", attendance_source = 'manual'" : ""}
          WHERE id = $1 AND event_id = $2
          RETURNING *
       )
       SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
         FROM updated ep
         LEFT JOIN users u ON u.id = ep.user_id`,
      [participantId, eventId, status],
    );

  let rows: EventParticipantRow[];
  try {
    rows = await write(true);
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    logger.warn(
      { err, eventId, participantId },
      "event_participants.attendance_source missing — run sql/040-auto-check-in.sql",
    );
    rows = await write(false);
  }
  return rows[0] ? mapParticipant(rows[0]) : null;
}

/**
 * A rider's own row on an event, or null. Matched on (event, user) rather than by row id because
 * the caller only knows who they are. `left_at` is NOT filtered here — the service decides what a
 * rider who has left is owed — but the ORDER puts the row that counts first, for the legacy
 * databases that can carry two rows for one (event, user) pair (see updateRegistrationStatus).
 */
export async function selectParticipantForEventUser(
  eventId: string,
  userId: number,
): Promise<EventParticipant | null> {
  const row = await queryOne<EventParticipantRow>(
    `SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM event_participants ep
       LEFT JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = $1 AND ep.user_id = $2
      ORDER BY
        CASE WHEN ep.left_at IS NULL THEN 0 ELSE 1 END,
        CASE ep.registration_status
          WHEN 'approved' THEN 1
          WHEN 'registered' THEN 2
          WHEN 'waiting_approval' THEN 3
          ELSE 4
        END,
        ep.joined_at DESC,
        ep.id DESC
      LIMIT 1`,
    [eventId, userId],
  );
  return row ? mapParticipant(row) : null;
}

/**
 * The automatic arrival write. Fires only on a rider nobody has written attendance for —
 * `unknown` AND a NULL source — so it can never overwrite an organizer's decision (manual ticks
 * and un-ticks both leave a non-NULL source) and a second call is a no-op.
 *
 * Returns the updated row when THIS call marked the rider, and null when the guard held (already
 * arrived, already decided by the organizer). The caller re-reads to tell those two apart.
 *
 * No missing-column fallback, unlike updateAttendanceStatus: this only runs for a ride whose
 * events.auto_check_in is true, and that column comes from the same migration.
 */
export async function markArrivedAutomatically(
  participantId: number,
  eventId: string,
): Promise<EventParticipant | null> {
  const rows = await query<EventParticipantRow>(
    `WITH updated AS (
       UPDATE event_participants
          SET attendance_status = 'present', attendance_source = 'auto'
        WHERE id = $1 AND event_id = $2
          AND attendance_status = 'unknown'
          AND attendance_source IS NULL
        RETURNING *
     )
     SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
       FROM updated ep
       LEFT JOIN users u ON u.id = ep.user_id`,
    [participantId, eventId],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

/**
 * Where the ride starts: the first point of its attached route, or null when it has none.
 *
 * `routes.start_lat/start_lon` is derived once at upload (routeLibrary.service) — no geometry is
 * read here. Newest attachment wins, the same tie-break every other event_routes read uses.
 */
export async function selectEventStartPoint(eventId: string): Promise<LatLng | null> {
  const row = await queryOne<{ start_lat: number | null; start_lon: number | null }>(
    `SELECT r.start_lat, r.start_lon
       FROM event_routes er
       JOIN routes r ON r.id = er.route_id
      WHERE er.event_id = $1
      ORDER BY er.created_at DESC
      LIMIT 1`,
    [eventId],
  );
  if (!row || row.start_lat === null || row.start_lon === null) return null;
  return { lat: Number(row.start_lat), lng: Number(row.start_lon) };
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
  const target = await queryOne<{ user_id: number | null }>(
    "SELECT user_id FROM event_participants WHERE id = $1 AND event_id = $2",
    [participantId, eventId],
  );
  if (!target) return null;

  if (target.user_id !== null) {
    const rows = await query<EventParticipantRow>(
      // Legacy DBs can carry duplicate rows for the same event/user pair. Keep them in sync,
      // then return one canonical row for API responses. Matched on (event_id, user_id) rather
      // than the row id, so `participantId` is deliberately NOT a parameter of this branch —
      // binding it without referencing it made Postgres fail the parse with 42P18 ("could not
      // determine data type of parameter $1").
      `WITH updated AS (
         UPDATE event_participants
            SET registration_status = $2
          WHERE event_id = $1 AND user_id = $3
          RETURNING *
       )
       SELECT ep.*, ${PARTICIPANT_DISPLAY_COLUMNS}
         FROM updated ep
         LEFT JOIN users u ON u.id = ep.user_id
        ORDER BY
          CASE ep.registration_status
            WHEN 'approved' THEN 1
            WHEN 'registered' THEN 2
            WHEN 'waiting_approval' THEN 3
            WHEN 'rejected' THEN 4
            ELSE 5
          END,
          CASE WHEN ep.left_at IS NULL THEN 0 ELSE 1 END,
          ep.joined_at DESC,
          ep.id DESC`,
      [eventId, status, target.user_id],
    );
    return rows[0] ? mapParticipant(rows[0]) : null;
  }

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

/**
 * Bulk-approve every rider still `waiting_approval` on this event — what the organizer means by
 * turning "requires approval" off: everyone queued under the old rule gets in, not just future
 * joiners (event.service.ts's updateEventDetails calls this on that one transition).
 *
 * Only `waiting_approval` moves. `rejected` stays rejected — turning approval off is not the
 * organizer un-rejecting someone, and `registered`/`approved` rows have nothing to do here.
 */
export async function approveAllWaitingParticipants(eventId: string): Promise<number> {
  return execute(
    "UPDATE event_participants SET registration_status = 'approved' " +
      "WHERE event_id = $1 AND registration_status = 'waiting_approval'",
    [eventId],
  );
}
