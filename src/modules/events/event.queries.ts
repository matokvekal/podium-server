// SQL for events, event_participants and location_points. No SQL lives anywhere else in
// this module.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract, and the
// location_points column names match that app's JSON. Neither may be renamed.

import { execute, query, queryOne } from "../../db/pool.js";
import type {
  DisplayMode,
  Event,
  EventParticipant,
  EventStatus,
  EventType,
  EventVisibility,
  ParticipantLastLocation,
  RegistrationStatus,
} from "../../db/types.js";

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
  owner_id: number | null;
  display_mode: DisplayMode;
  status: EventStatus;
  visibility: EventVisibility;
  description: string | null;
  location: string | null;
  finished_at: Date | null;
  requires_approval: boolean;
  is_paused: boolean;
  show_event_info: boolean;
  show_participants: boolean;
  show_route: boolean;
  show_live_locations: boolean;
  show_history_locations: boolean;
  show_results: boolean;
}

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
  registration_status: EventParticipant["registrationStatus"];
  attendance_status: EventParticipant["attendanceStatus"];
  result_status: EventParticipant["resultStatus"];
  finished_at: Date | null;
  finish_position: number | null;
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
    ownerId: row.owner_id,
    displayMode: row.display_mode,
    status: row.status,
    visibility: row.visibility,
    description: row.description,
    location: row.location,
    finishedAt: row.finished_at,
    requiresApproval: row.requires_approval,
    isPaused: row.is_paused,
    showEventInfo: row.show_event_info,
    showParticipants: row.show_participants,
    showRoute: row.show_route,
    showLiveLocations: row.show_live_locations,
    showHistoryLocations: row.show_history_locations,
    showResults: row.show_results,
  };
}

/** Exported so the participants module can map the same table's rows without duplicating this. */
export function mapParticipant(row: EventParticipantRow): EventParticipant {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    bib: row.bib,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    name: row.name,
    email: row.email,
    phone: row.phone,
    category: row.category,
    registrationStatus: row.registration_status,
    attendanceStatus: row.attendance_status,
    resultStatus: row.result_status,
    finishedAt: row.finished_at,
    finishPosition: row.finish_position,
  };
}

export async function selectActiveEventByCode(code: string): Promise<Event | null> {
  const row = await queryOne<EventRow>(
    "SELECT * FROM events WHERE code = $1 AND is_active = TRUE LIMIT 1",
    [code],
  );
  return row ? mapEvent(row) : null;
}

export async function selectEventById(id: string): Promise<Event | null> {
  const row = await queryOne<EventRow>("SELECT * FROM events WHERE id = $1", [id]);
  return row ? mapEvent(row) : null;
}

/** For the one-live-event-per-owner check in changeEventStatus. */
export async function selectLiveEventForOwner(ownerId: number): Promise<Event | null> {
  const row = await queryOne<EventRow>(
    "SELECT * FROM events WHERE owner_id = $1 AND status = 'live' LIMIT 1",
    [ownerId],
  );
  return row ? mapEvent(row) : null;
}

/**
 * Every event the user owns or has joined, excluding cancelled ones. Filtering into
 * mine/joined/upcoming/live/past happens in the service — event counts per user are small
 * enough that one simple query beats five subtly different ones.
 */
export async function selectEventsForUser(userId: number): Promise<Event[]> {
  const rows = await query<EventRow>(
    `SELECT DISTINCT e.* FROM events e
       LEFT JOIN event_participants ep ON ep.event_id = e.id AND ep.user_id = $1
      WHERE (e.owner_id = $1 OR ep.user_id = $1) AND e.status != 'cancelled'
      ORDER BY e.starts_at ASC NULLS LAST, e.created_at DESC`,
    [userId],
  );
  return rows.map(mapEvent);
}

export async function selectPublicEvents(limit: number, offset: number): Promise<Event[]> {
  const rows = await query<EventRow>(
    `SELECT * FROM events WHERE visibility = 'public' AND status NOT IN ('cancelled', 'draft')
      ORDER BY starts_at ASC NULLS LAST
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapEvent);
}

export interface CreateEventInput {
  id: string;
  code: string;
  name: string;
  type: EventType;
  requiresBib: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  ownerId: number;
  displayMode: DisplayMode;
  visibility: EventVisibility;
  description: string | null;
  location: string | null;
  requiresApproval: boolean;
}

/** New events always start as a draft, and a draft is never is_active — see event.service.ts. */
export async function insertEvent(input: CreateEventInput): Promise<Event> {
  const row = await queryOne<EventRow>(
    `INSERT INTO events
        (id, code, name, type, requires_bib, starts_at, ends_at, is_active,
         owner_id, display_mode, status, visibility, description, location, requires_approval)
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, 'draft', $10, $11, $12, $13)
      RETURNING *`,
    [
      input.id,
      input.code,
      input.name,
      input.type,
      input.requiresBib,
      input.startsAt,
      input.endsAt,
      input.ownerId,
      input.displayMode,
      input.visibility,
      input.description,
      input.location,
      input.requiresApproval,
    ],
  );
  if (!row) throw new Error("insertEvent returned no row");
  return mapEvent(row);
}

export interface UpdateEventInput {
  name?: string;
  type?: EventType;
  requiresBib?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  displayMode?: DisplayMode;
  visibility?: EventVisibility;
  description?: string;
  location?: string;
  showEventInfo?: boolean;
  showParticipants?: boolean;
  showRoute?: boolean;
  showLiveLocations?: boolean;
  showHistoryLocations?: boolean;
  showResults?: boolean;
  requiresApproval?: boolean;
}

/** Partial update — COALESCE keeps the stored value for anything the caller left out. */
export async function updateEvent(eventId: string, input: UpdateEventInput): Promise<Event | null> {
  const rows = await query<EventRow>(
    `UPDATE events
        SET name = COALESCE($2, name),
            type = COALESCE($3, type),
            requires_bib = COALESCE($4, requires_bib),
            starts_at = COALESCE($5, starts_at),
            ends_at = COALESCE($6, ends_at),
            display_mode = COALESCE($7, display_mode),
            visibility = COALESCE($8, visibility),
            description = COALESCE($9, description),
            location = COALESCE($10, location),
            show_event_info = COALESCE($11, show_event_info),
            show_participants = COALESCE($12, show_participants),
            show_route = COALESCE($13, show_route),
            show_live_locations = COALESCE($14, show_live_locations),
            show_history_locations = COALESCE($15, show_history_locations),
            show_results = COALESCE($16, show_results),
            requires_approval = COALESCE($17, requires_approval),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      eventId,
      input.name ?? null,
      input.type ?? null,
      input.requiresBib ?? null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.displayMode ?? null,
      input.visibility ?? null,
      input.description ?? null,
      input.location ?? null,
      input.showEventInfo ?? null,
      input.showParticipants ?? null,
      input.showRoute ?? null,
      input.showLiveLocations ?? null,
      input.showHistoryLocations ?? null,
      input.showResults ?? null,
      input.requiresApproval ?? null,
    ],
  );
  return rows[0] ? mapEvent(rows[0]) : null;
}

/** Pause/resume only ever touches this one column — general edits are locked out while live. */
export async function updateEventPaused(eventId: string, isPaused: boolean): Promise<Event | null> {
  const rows = await query<EventRow>(
    "UPDATE events SET is_paused = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [eventId, isPaused],
  );
  return rows[0] ? mapEvent(rows[0]) : null;
}

/** Keeps is_active in step with status — the application's job, per plan/02-database-schema.md. */
export async function updateEventStatus(
  eventId: string,
  status: EventStatus,
  isActive: boolean,
  finishedAt: Date | null,
): Promise<Event | null> {
  const rows = await query<EventRow>(
    `UPDATE events SET status = $2, is_active = $3, finished_at = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [eventId, status, isActive, finishedAt],
  );
  return rows[0] ? mapEvent(rows[0]) : null;
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
 * `initialStatus` only takes effect on the INSERT branch: a repeat join must never un-approve
 * (or re-pend) someone by overwriting their existing registration_status.
 */
export async function upsertParticipant(input: {
  eventId: string;
  userId: number;
  bib: string | undefined;
  initialStatus: RegistrationStatus;
}): Promise<EventParticipant> {
  const row = await queryOne<EventParticipantRow>(
    `INSERT INTO event_participants (event_id, user_id, bib, registration_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_id, user_id)
      DO UPDATE SET bib = COALESCE($3, event_participants.bib), left_at = NULL
      RETURNING *`,
    [input.eventId, input.userId, input.bib ?? null, input.initialStatus],
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

/** The viewer's own participation row, if any — drives the Register button and viewer tiering. */
export async function selectParticipantByEventAndUser(
  eventId: string,
  userId: number,
): Promise<EventParticipant | null> {
  const row = await queryOne<EventParticipantRow>(
    "SELECT * FROM event_participants WHERE event_id = $1 AND user_id = $2",
    [eventId, userId],
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

// ---------------------------------------------------------------------------------------
// participant_last_location — where everyone is right now. See sql/005-tracking.sql.
// ---------------------------------------------------------------------------------------

interface ParticipantLastLocationRow {
  event_id: string;
  participant_id: number;
  recorded_at: Date | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  emergency: boolean;
  distance_travelled_km: number | null;
  updated_at: Date;
}

function mapLastLocation(row: ParticipantLastLocationRow): ParticipantLastLocation {
  return {
    eventId: row.event_id,
    participantId: row.participant_id,
    recordedAt: row.recorded_at,
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    emergency: row.emergency,
    distanceTravelledKm: row.distance_travelled_km,
    updatedAt: row.updated_at,
  };
}

/** The rider's current position, used to compute the distance delta before each upsert. */
export async function selectLastLocation(
  eventId: string,
  participantId: number,
): Promise<ParticipantLastLocation | null> {
  const row = await queryOne<ParticipantLastLocationRow>(
    "SELECT * FROM participant_last_location WHERE event_id = $1 AND participant_id = $2",
    [eventId, participantId],
  );
  return row ? mapLastLocation(row) : null;
}

/**
 * GET /:eventId/live reads only this table (sql/005-tracking.sql). `participantIds === null`
 * means unrestricted (the owner); a non-null array is the caller's already-clamped selection.
 */
export async function selectLastLocationsForEvent(
  eventId: string,
  participantIds: number[] | null,
): Promise<ParticipantLastLocation[]> {
  const rows = await query<ParticipantLastLocationRow>(
    `SELECT * FROM participant_last_location
      WHERE event_id = $1
        AND ($2::bigint[] IS NULL OR participant_id = ANY($2::bigint[]))
      ORDER BY updated_at DESC`,
    [eventId, participantIds],
  );
  return rows.map(mapLastLocation);
}

/**
 * Newer-wins upsert — a batch that arrives late (queued through a dead zone) must never drag
 * a rider's marker backwards. Fire-and-forget: the WHERE clause silently no-ops a stale write,
 * and callers don't need the row back.
 */
export async function upsertParticipantLastLocation(
  eventId: string,
  participantId: number,
  point: { lat: number; lng: number; accuracy?: number; recordedAt: Date; emergency: boolean },
  distanceTravelledKm: number,
): Promise<void> {
  await execute(
    `INSERT INTO participant_last_location
        (event_id, participant_id, recorded_at, lat, lng, accuracy, emergency, distance_travelled_km)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id, participant_id) DO UPDATE
        SET recorded_at = EXCLUDED.recorded_at,
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            accuracy = EXCLUDED.accuracy,
            emergency = EXCLUDED.emergency,
            distance_travelled_km = EXCLUDED.distance_travelled_km,
            updated_at = NOW()
      WHERE participant_last_location.recorded_at IS NULL
         OR participant_last_location.recorded_at < EXCLUDED.recorded_at`,
    [
      eventId,
      participantId,
      point.recordedAt,
      point.lat,
      point.lng,
      point.accuracy ?? null,
      point.emergency,
      distanceTravelledKm,
    ],
  );
}
