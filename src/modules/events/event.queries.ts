// SQL for events, event_participants and location_points. No SQL lives anywhere else in
// this module.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract, and the
// location_points column names match that app's JSON. Neither may be renamed.

import { query, queryOne } from "../../db/pool.js";
import type { Event, EventParticipant, EventType } from "../../db/types.js";

interface EventRow {
  id: string;
  code: string;
  name: string;
  type: EventType;
  requires_bib: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface EventParticipantRow {
  id: number;
  event_id: string;
  user_id: number | null;
  bib: string | null;
  joined_at: Date;
  left_at: Date | null;
}

function mapEvent(row: EventRow): Event {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    requiresBib: row.requires_bib,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapParticipant(row: EventParticipantRow): EventParticipant {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    bib: row.bib,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

export async function selectActiveEventByCode(code: string): Promise<Event | null> {
  const row = await queryOne<EventRow>(
    "SELECT * FROM events WHERE code = $1 AND is_active = TRUE LIMIT 1",
    [code],
  );
  return row ? mapEvent(row) : null;
}

/** Codes already handed out for a given DDMMYYYY prefix, so the next suffix can be picked. */
export async function selectEventCodesWithPrefix(prefix: string): Promise<string[]> {
  const rows = await query<{ code: string }>("SELECT code FROM events WHERE code LIKE $1", [
    `${prefix}%`,
  ]);
  return rows.map((row) => row.code);
}

/**
 * Idempotent join. A repeat join keeps the existing row — so `participantId` never changes
 * under the app — updates the bib only when a new one was supplied, and clears left_at.
 */
export async function upsertParticipant(input: {
  eventId: string;
  userId: number;
  bib: string | undefined;
}): Promise<EventParticipant> {
  const row = await queryOne<EventParticipantRow>(
    `INSERT INTO event_participants (event_id, user_id, bib)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id, user_id)
      DO UPDATE SET bib = COALESCE($3, event_participants.bib), left_at = NULL
      RETURNING *`,
    [input.eventId, input.userId, input.bib ?? null],
  );
  if (!row) throw new Error("upsertParticipant returned no row");
  return mapParticipant(row);
}

export async function selectParticipantForUser(
  participantId: number,
  userId: number,
): Promise<EventParticipant | null> {
  const row = await queryOne<EventParticipantRow>(
    "SELECT * FROM event_participants WHERE id = $1 AND user_id = $2",
    [participantId, userId],
  );
  return row ? mapParticipant(row) : null;
}

export interface LocationPointInput {
  lat: number;
  lng: number;
  accuracy?: number;
  recordedAt: Date;
  emergency: boolean;
}

/**
 * One statement for the whole batch (up to 200 points), not one per point. The arrays are
 * bound as five parameters and expanded by UNNEST, so the SQL text is identical for a
 * batch of 1 and a batch of 200 and the plan is cached.
 *
 * `recorded_at` is the device's own GPS time. It is stored exactly as sent — a batch that
 * waited out a dead zone must keep the time the rider was actually there.
 */
export async function insertLocationPoints(
  participantId: number,
  points: LocationPointInput[],
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO location_points (participant_id, lat, lng, accuracy, recorded_at, emergency)
      SELECT $1, point.lat, point.lng, point.accuracy, point.recorded_at, point.emergency
        FROM UNNEST($2::double precision[], $3::double precision[], $4::double precision[],
                    $5::timestamptz[], $6::boolean[])
          AS point(lat, lng, accuracy, recorded_at, emergency)
      RETURNING id`,
    [
      participantId,
      points.map((point) => point.lat),
      points.map((point) => point.lng),
      points.map((point) => point.accuracy ?? null),
      points.map((point) => point.recordedAt),
      points.map((point) => point.emergency),
    ],
  );
  return rows.length;
}
