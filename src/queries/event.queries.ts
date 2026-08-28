// SQL for events, event_participants and location_points. No SQL lives anywhere else in
// this module.
//
// ⚠ event_participants.id is `participantId` in the frozen Android contract, and the
// location_points column names match that app's JSON. Neither may be renamed.

import { execute, query, queryOne, withTransaction } from "../db/pool.js";
import type {
  ActivityType,
  DisplayMode,
  Event,
  EventParticipant,
  EventStatus,
  EventType,
  EventVisibility,
  ParticipantLastLocation,
  RegistrationStatus,
  RiderLevel,
} from "../db/types.js";
import { logger } from "../lib/logger.js";
import { resolveImageUrl } from "../lib/user-images.js";

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
  area: string | null;
  finished_at: Date | null;
  activity_type: ActivityType | null;
  level: RiderLevel | null;
  organizer_group: string | null;
  team_id: number | null;
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
  team: string | null;
  country_code: string | null;
  group_id: number | null;
  registration_status: EventParticipant["registrationStatus"];
  attendance_status: EventParticipant["attendanceStatus"];
  result_status: EventParticipant["resultStatus"];
  finished_at: Date | null;
  finish_position: number | null;

  // Only present on the queries that join `users` — see PARTICIPANT_DISPLAY_COLUMNS. A plain
  // `SELECT *` leaves both undefined, which mapParticipant treats as "nothing to fall back to".
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_type?: string | null;
  avatar_value?: string | null;
}

/**
 * A participant who joined through the app has no `event_participants.name` — that column is
 * only filled in by the organizer's manual-add path. sql/003-participants.sql states the rule:
 * the row's own name when set, otherwise the linked user's. Resolved here at read time rather
 * than copied at join time, so a rider who later corrects their profile is corrected in every
 * event they have ever ridden.
 *
 * Any query selecting participants for display must join `users AS u` and include this.
 */
export const PARTICIPANT_DISPLAY_COLUMNS = `
  COALESCE(
    ep.name,
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    u.nickname
  ) AS display_name,
  u.avatar_url,
  -- The rider's own chosen avatar, resolved into avatarUrl by mapParticipant so every start
  -- list, LIVE payload and result row shows the same picture as their profile does.
  u.avatar_type,
  u.avatar_value`;

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
    area: row.area,
    finishedAt: row.finished_at,
    activityType: row.activity_type,
    level: row.level,
    organizerGroup: row.organizer_group,
    teamId: row.team_id,
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
    // display_name is undefined on queries that did not join `users`; the row's own name is
    // still the right answer there (manual entries always have one).
    name: row.display_name ?? row.name,
    // The EFFECTIVE avatar: their upload, else their chosen preset, else the Google picture.
    // Resolved here so the field keeps the exact shape every existing client already reads.
    avatarUrl: resolveImageUrl("avatar", row.avatar_type, row.avatar_value, row.avatar_url ?? null),
    email: row.email,
    phone: row.phone,
    category: row.category,
    team: row.team,
    countryCode: row.country_code,
    groupId: row.group_id,
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
    // The rejected filter sits in the JOIN, not the WHERE: in the WHERE it would also drop
    // events this user OWNS but was rejected from, which cannot happen today but is exactly
    // the kind of thing that starts happening once co-organizers land.
    `SELECT DISTINCT e.* FROM events e
       LEFT JOIN event_participants ep
              ON ep.event_id = e.id AND ep.user_id = $1 AND ep.registration_status != 'rejected'
      WHERE (e.owner_id = $1 OR ep.user_id = $1) AND e.status != 'cancelled'
      ORDER BY e.starts_at ASC NULLS LAST, e.created_at DESC`,
    [userId],
  );
  return rows.map(mapEvent);
}

/**
 * Upcoming public rides by organizers this user follows, and by teams they belong to — the
 * "may see next future rides" half of following someone. Public only: following a person is
 * not an invitation to their private rides.
 */
export async function selectUpcomingEventsForFollowed(userId: number): Promise<Event[]> {
  const rows = await query<EventRow>(
    `SELECT DISTINCT e.* FROM events e
       LEFT JOIN user_follows f ON f.followee_id = e.owner_id AND f.follower_id = $1
       LEFT JOIN team_members tm
              ON tm.team_id = e.team_id AND tm.user_id = $1 AND tm.status = 'approved'
      WHERE e.visibility = 'public'
        AND e.status IN ('published', 'registration_open', 'ready', 'live')
        AND e.owner_id <> $1
        AND (f.follower_id IS NOT NULL OR tm.user_id IS NOT NULL)
      ORDER BY e.starts_at ASC NULLS LAST`,
    [userId],
  );
  return rows.map(mapEvent);
}

/** Rides this user created in the last 7 days — the free plan's rolling window. */
export async function countEventsCreatedSince(ownerId: number, since: Date): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM events WHERE owner_id = $1 AND created_at >= $2",
    [ownerId, since],
  );
  return Number(row?.count ?? 0);
}

/**
 * Layer 3 of AUTHORIZATION.md. Idempotent, because event creation may be retried and a
 * duplicate member row would be a unique-index violation rather than a no-op.
 */
export async function insertEventMember(
  eventId: string,
  userId: number,
  role: "owner" | "operator" | "viewer",
): Promise<void> {
  await execute(
    `INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, $3)
      ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [eventId, userId, role],
  );
}

export interface PublicEventFilters {
  q?: string;
  type?: EventType;
  bucket?: "live" | "upcoming" | "finished";
  activityType?: ActivityType;
  level?: RiderLevel;
  sort: "soonest" | "latest" | "newest";
  limit: number;
  offset: number;
}

function isMissingColumnError(err: unknown): err is { code: string; message?: string } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42703";
}

/**
 * Same "$n IS NULL OR <test>" shape as selectPublicRoutes: one constant statement rather than
 * SQL assembled at runtime, so the fake DB and a reader can both check it and Postgres can
 * cache one plan.
 *
 * The `finished` bucket deliberately also catches an event whose end time has passed while its
 * stored status never moved — nothing flips that automatically (see computeEffectiveStatus),
 * and a rider looking for last Saturday's ride does not care which of those it is.
 */
export async function selectPublicEvents(
  filters: PublicEventFilters,
): Promise<{ events: Event[]; total: number }> {
  const where = `visibility = 'public'
        AND status NOT IN ('cancelled', 'draft')
        AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR location ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR type = $2)
        AND ($3::text IS NULL OR activity_type = $3)
        AND ($4::text IS NULL OR level = $4)
        AND (
          $5::text IS NULL
          OR ($5 = 'live' AND status = 'live')
          OR ($5 = 'upcoming'
              AND status IN ('published', 'registration_open', 'ready')
              AND (ends_at IS NULL OR ends_at >= NOW()))
          OR ($5 = 'finished'
              AND (status = 'finished' OR (ends_at IS NOT NULL AND ends_at < NOW())))
        )`;

  const params = [
    filters.q ?? null,
    filters.type ?? null,
    filters.activityType ?? null,
    filters.level ?? null,
    filters.bucket ?? null,
  ];

  // Whitelisted, never interpolated from user input — `sort` is a zod enum upstream.
  const orderBy = {
    soonest: "starts_at ASC NULLS LAST",
    latest: "starts_at DESC NULLS LAST",
    newest: "created_at DESC",
  }[filters.sort];

  try {
    const rows = await query<EventRow>(
      `SELECT * FROM events WHERE ${where} ORDER BY ${orderBy} LIMIT $6 OFFSET $7`,
      [...params, filters.limit, filters.offset],
    );
    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events WHERE ${where}`,
      params,
    );
    return { events: rows.map(mapEvent), total: Number(countRow?.count ?? 0) };
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;

    // Older local schemas may not have activity_type/level yet.
    logger.warn({ err }, "events profile columns missing; using legacy public-events query");

    const legacyWhere = `visibility = 'public'
        AND status NOT IN ('cancelled', 'draft')
        AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR location ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR type = $2)
        AND (
          $3::text IS NULL
          OR ($3 = 'live' AND status = 'live')
          OR ($3 = 'upcoming'
              AND status IN ('published', 'registration_open', 'ready')
              AND (ends_at IS NULL OR ends_at >= NOW()))
          OR ($3 = 'finished'
              AND (status = 'finished' OR (ends_at IS NOT NULL AND ends_at < NOW())))
        )`;
    const legacyParams = [filters.q ?? null, filters.type ?? null, filters.bucket ?? null];

    const rows = await query<EventRow>(
      `SELECT * FROM events WHERE ${legacyWhere} ORDER BY ${orderBy} LIMIT $4 OFFSET $5`,
      [...legacyParams, filters.limit, filters.offset],
    );
    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events WHERE ${legacyWhere}`,
      legacyParams,
    );
    return { events: rows.map(mapEvent), total: Number(countRow?.count ?? 0) };
  }
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
  area: string | null;
  activityType: ActivityType | null;
  level: RiderLevel | null;
  organizerGroup: string | null;
  requiresApproval: boolean;
  /** The status the event is created in, and whether that status counts as active. */
  status: EventStatus;
  isActive: boolean;
  /** null for any of these means "leave the column default alone" — see the COALESCEs below. */
  showEventInfo: boolean | null;
  showParticipants: boolean | null;
  showRoute: boolean | null;
  showLiveLocations: boolean | null;
  showHistoryLocations: boolean | null;
  showResults: boolean | null;
}

/** The caller picks the starting status (POST /events defaults to "published" — this product
 * has no draft workflow) and the matching is_active; the two stay in lockstep because
 * event.service.ts derives isActive from status with isActiveForStatus. */
export async function insertEvent(input: CreateEventInput): Promise<Event> {
  try {
    const row = await queryOne<EventRow>(
      // The COALESCE defaults repeat sql/002-events-podium.sql's column defaults on purpose: an
      // explicit INSERT column list cannot fall back to DEFAULT per-row, and the caller passes
      // null for anything the create form did not ask about.
      `INSERT INTO events
        (id, code, name, type, requires_bib, starts_at, ends_at, is_active,
         owner_id, display_mode, status, visibility, description, location, area, requires_approval,
         show_event_info, show_participants, show_route,
         show_live_locations, show_history_locations, show_results,
         activity_type, level, organizer_group)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              COALESCE($17, TRUE), COALESCE($18, FALSE), COALESCE($19, TRUE),
              COALESCE($20, FALSE), COALESCE($21, FALSE), COALESCE($22, TRUE),
              $23, $24, $25)
      RETURNING *`,
      [
        input.id,
        input.code,
        input.name,
        input.type,
        input.requiresBib,
        input.startsAt,
        input.endsAt,
        input.isActive,
        input.ownerId,
        input.displayMode,
        input.status,
        input.visibility,
        input.description,
        input.location,
        input.area,
        input.requiresApproval,
        input.showEventInfo,
        input.showParticipants,
        input.showRoute,
        input.showLiveLocations,
        input.showHistoryLocations,
        input.showResults,
        input.activityType,
        input.level,
        input.organizerGroup,
      ],
    );
    if (!row) throw new Error("insertEvent returned no row");
    return mapEvent(row);
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;

    // Legacy local schema fallback (before activity_type/level/organizer_group existed).
    logger.warn({ err }, "events profile columns missing; inserting event with legacy columns");

    const row = await queryOne<EventRow>(
      `INSERT INTO events
          (id, code, name, type, requires_bib, starts_at, ends_at, is_active,
           owner_id, display_mode, status, visibility, description, location, area, requires_approval,
           show_event_info, show_participants, show_route,
           show_live_locations, show_history_locations, show_results)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          COALESCE($17, TRUE), COALESCE($18, FALSE), COALESCE($19, TRUE),
          COALESCE($20, FALSE), COALESCE($21, FALSE), COALESCE($22, TRUE))
        RETURNING *`,
      [
        input.id,
        input.code,
        input.name,
        input.type,
        input.requiresBib,
        input.startsAt,
        input.endsAt,
        input.isActive,
        input.ownerId,
        input.displayMode,
        input.status,
        input.visibility,
        input.description,
        input.location,
        input.area,
        input.requiresApproval,
        input.showEventInfo,
        input.showParticipants,
        input.showRoute,
        input.showLiveLocations,
        input.showHistoryLocations,
        input.showResults,
      ],
    );
    if (!row) throw new Error("insertEvent legacy fallback returned no row");
    return mapEvent(row);
  }
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
  area?: string;
  showEventInfo?: boolean;
  showParticipants?: boolean;
  showRoute?: boolean;
  showLiveLocations?: boolean;
  showHistoryLocations?: boolean;
  showResults?: boolean;
  requiresApproval?: boolean;
  activityType?: ActivityType;
  level?: RiderLevel;
  organizerGroup?: string;
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
            area = COALESCE($11, area),
            show_event_info = COALESCE($12, show_event_info),
            show_participants = COALESCE($13, show_participants),
            show_route = COALESCE($14, show_route),
            show_live_locations = COALESCE($15, show_live_locations),
            show_history_locations = COALESCE($16, show_history_locations),
            show_results = COALESCE($17, show_results),
            requires_approval = COALESCE($18, requires_approval),
            activity_type = COALESCE($19, activity_type),
            level = COALESCE($20, level),
            organizer_group = COALESCE($21, organizer_group),
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
      input.area ?? null,
      input.showEventInfo ?? null,
      input.showParticipants ?? null,
      input.showRoute ?? null,
      input.showLiveLocations ?? null,
      input.showHistoryLocations ?? null,
      input.showResults ?? null,
      input.requiresApproval ?? null,
      input.activityType ?? null,
      input.level ?? null,
      input.organizerGroup ?? null,
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

/**
 * Start-list occupancy, split the way the capacity rule needs it (see
 * authz/participant-capacity.ts): `approved` = registration_status in ('registered','approved'),
 * `pending` = 'waiting_approval', both with left_at IS NULL. Rejected / left riders are excluded.
 * Plain read — the concurrency-safe path is insertParticipantIfRoom.
 */
export async function countJoinedParticipants(
  eventId: string,
): Promise<{ approved: number; pending: number }> {
  const row = await queryOne<{ approved: string; pending: string }>(
    `SELECT
        COUNT(*) FILTER (
          WHERE registration_status IN ('registered', 'approved') AND left_at IS NULL
        )::text AS approved,
        COUNT(*) FILTER (
          WHERE registration_status = 'waiting_approval' AND left_at IS NULL
        )::text AS pending
       FROM event_participants
      WHERE event_id = $1`,
    [eventId],
  );
  return { approved: Number(row?.approved ?? 0), pending: Number(row?.pending ?? 0) };
}

/**
 * The concurrency-safe join write. A per-event advisory lock (held to end of transaction)
 * serialises concurrent joins for the same event, so two riders cannot both pass the capacity
 * check and land on a full list.
 *
 * A rider who already has a row holds a slot: their join is idempotent and skips the capacity
 * check entirely (bib is updated if a new one was given, left_at is cleared). Only a genuinely
 * new rider is counted against `maxParticipants`.
 */
export async function insertParticipantIfRoom(input: {
  eventId: string;
  userId: number;
  bib: string | undefined;
  initialStatus: RegistrationStatus;
  maxParticipants: number;
}): Promise<
  | { ok: true; participant: EventParticipant }
  | { ok: false; approved: number; pending: number; limit: number }
> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-join:${input.eventId}`]);

    const existing = await tx.queryOne<EventParticipantRow>(
      "SELECT * FROM event_participants WHERE event_id = $1 AND user_id = $2",
      [input.eventId, input.userId],
    );
    if (existing) {
      const updated = await tx.queryOne<EventParticipantRow>(
        `UPDATE event_participants
            SET bib = COALESCE($3, bib), left_at = NULL
          WHERE event_id = $1 AND user_id = $2
          RETURNING *`,
        [input.eventId, input.userId, input.bib ?? null],
      );
      if (!updated) throw new Error("insertParticipantIfRoom: update returned no row");
      return { ok: true, participant: mapParticipant(updated) };
    }

    const countRow = await tx.queryOne<{ approved: string; pending: string }>(
      `SELECT
          COUNT(*) FILTER (
            WHERE registration_status IN ('registered', 'approved') AND left_at IS NULL
          )::text AS approved,
          COUNT(*) FILTER (
            WHERE registration_status = 'waiting_approval' AND left_at IS NULL
          )::text AS pending
         FROM event_participants
        WHERE event_id = $1`,
      [input.eventId],
    );
    const approved = Number(countRow?.approved ?? 0);
    const pending = Number(countRow?.pending ?? 0);
    if (approved + pending >= input.maxParticipants) {
      return { ok: false, approved, pending, limit: input.maxParticipants };
    }

    const inserted = await tx.queryOne<EventParticipantRow>(
      `INSERT INTO event_participants (event_id, user_id, bib, registration_status)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (event_id, user_id)
        DO UPDATE SET bib = COALESCE($3, event_participants.bib), left_at = NULL
        RETURNING *`,
      [input.eventId, input.userId, input.bib ?? null, input.initialStatus],
    );
    if (!inserted) throw new Error("insertParticipantIfRoom: insert returned no row");
    return { ok: true, participant: mapParticipant(inserted) };
  });
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
    `SELECT * FROM event_participants
      WHERE event_id = $1 AND user_id = $2
      ORDER BY
        CASE registration_status
          WHEN 'approved' THEN 1
          WHEN 'registered' THEN 2
          WHEN 'waiting_approval' THEN 3
          WHEN 'rejected' THEN 4
          ELSE 5
        END,
        CASE WHEN left_at IS NULL THEN 0 ELSE 1 END,
        joined_at DESC,
        id DESC
      LIMIT 1`,
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
