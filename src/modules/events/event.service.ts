import { randomUUID } from "node:crypto";
import type {
  DisplayMode,
  Event,
  EventParticipant,
  EventStatus,
  EventType,
  EventVisibility,
  RegistrationStatus,
} from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { haversineDistanceKm } from "../../lib/geo.js";
import { logger } from "../../lib/logger.js";
import { selectParticipantsForEvent } from "../participants/participants.queries.js";
import { getMaxConcurrentLiveEvents } from "./entitlements.js";
import {
  countLiveEventsForOwner,
  insertEvent,
  insertLocationPoints,
  type LocationPointInput,
  leaveEventForUser,
  selectActiveEventByCode,
  selectEventById,
  selectEventCodesWithPrefix,
  selectEventsForUser,
  selectLastLocation,
  selectLastLocationsForEvent,
  selectParticipantByEventAndUser,
  selectParticipantForUser,
  selectPublicEvents,
  type UpdateEventInput,
  updateEvent,
  updateEventPaused,
  updateEventStatus,
  upsertParticipant,
  upsertParticipantLastLocation,
} from "./event.queries.js";
import { datePrefix, letterSuffix } from "./event-code.js";

export async function findActiveEventByCode(code: string): Promise<Event | null> {
  return selectActiveEventByCode(code);
}

/**
 * Next event code for `now`: today's date (DDMMYYYY) plus the first unused letter suffix
 * (A, B, ... Z, AA, AB, ...) among events already created today.
 */
export async function generateEventCode(now = new Date()): Promise<string> {
  const prefix = datePrefix(now);
  const todaysCodes = await selectEventCodesWithPrefix(prefix);
  const usedSuffixes = new Set(todaysCodes.map((code) => code.slice(prefix.length).toUpperCase()));

  let index = 0;
  while (usedSuffixes.has(letterSuffix(index))) {
    index++;
  }
  return `${prefix}${letterSuffix(index)}`;
}

export function toEventConfig(event: Event) {
  return {
    eventId: event.id,
    name: event.name,
    type: event.type,
    requiresBib: event.requiresBib,
  };
}

/**
 * Idempotent: re-joining the same event returns the rider's existing participant row
 * (e.g. bib updated) rather than erroring, since the app may retry after a network drop.
 */
export async function joinEvent(
  userId: number,
  eventCode: string,
  bib: string | undefined,
): Promise<{ event: Event; participant: EventParticipant }> {
  const event = await findActiveEventByCode(eventCode);
  if (!event) {
    logger.warn({ eventCode, userId }, "joinEvent: event not found");
    throw new ApiError(404, "Event not found");
  }

  // Creator/owner is already the organizer by definition and must never create a
  // self-membership row that could appear as pending/rejected.
  if (event.ownerId === userId) {
    throw new ApiError(400, "Event owner is already registered as organizer");
  }

  if (event.requiresBib && !bib) {
    logger.warn({ eventId: event.id, userId }, "joinEvent: missing required bib");
    throw new ApiError(400, "This event requires a bib number");
  }

  const initialStatus: RegistrationStatus = event.requiresApproval
    ? "waiting_approval"
    : "registered";
  const participant = await upsertParticipant({
    eventId: event.id,
    userId,
    bib,
    initialStatus,
  });
  logger.info({ eventId: event.id, userId, participantId: participant.id }, "user joined event");

  return { event, participant };
}

/**
 * Idempotent counterpart to joinEvent: leaving twice returns the same already-left state
 * rather than erroring, so the client can call it freely. Only a caller who never joined this
 * event at all (no row with their user_id) gets 404. Rejoining reuses this same row (see
 * upsertParticipant above), so leaving never needs to touch participantId, and joinedAt is
 * deliberately left alone here — it's the original first-join date, not "last activity".
 */
export async function leaveEvent(eventId: string, userId: number): Promise<EventParticipant> {
  const updated = await leaveEventForUser(eventId, userId);
  if (updated) {
    logger.info({ eventId, userId, participantId: updated.id }, "user left event");
    return updated;
  }

  const existing = await selectParticipantByEventAndUser(eventId, userId);
  if (!existing) {
    throw new ApiError(404, "You are not registered for this event");
  }
  return existing; // already left — idempotent no-op
}

export async function findParticipantForUser(
  participantId: number,
  userId: number,
): Promise<EventParticipant | null> {
  return selectParticipantForUser(participantId, userId);
}

/**
 * Ingest always writes the raw points; here we also keep participant_last_location current so
 * GET /:eventId/live has something to read (see sql/005-tracking.sql — that table is the only
 * one the live map queries). Only the batch's newest point moves the marker; distance travelled
 * is a running total against whatever position was there before.
 */
export async function saveLocationBatch(
  eventId: string,
  participantId: number,
  points: LocationPointInput[],
): Promise<number> {
  const saved = await insertLocationPoints(participantId, points);

  const lastPoint = points.reduce((latest, point) =>
    point.recordedAt.getTime() > latest.recordedAt.getTime() ? point : latest,
  );
  const prior = await selectLastLocation(eventId, participantId);
  const priorDistance = prior?.distanceTravelledKm ?? 0;
  const delta =
    prior?.lat != null && prior?.lng != null
      ? haversineDistanceKm(
        { lat: prior.lat, lng: prior.lng },
        { lat: lastPoint.lat, lng: lastPoint.lng },
      )
      : 0;
  await upsertParticipantLastLocation(eventId, participantId, lastPoint, priorDistance + delta);

  logger.info({ participantId, saved }, "location batch saved");
  return saved;
}

// ---------------------------------------------------------------------------------------
// Ownership, CRUD and the status workflow — milestone 2.
// ---------------------------------------------------------------------------------------

export function assertOwner(event: Event, userId: number): void {
  if (event.ownerId !== userId) {
    throw new ApiError(403, "Only the event owner may do this");
  }
}

/** draft -> published -> live -> finished, with registration_open/ready as optional
 * waypoints an owner may still pass through manually — but going live only ever requires
 * being published, not walking every waypoint first. Any non-terminal state may move to
 * cancelled. finished and cancelled are terminal. */
const ALLOWED_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["published", "cancelled"],
  published: ["registration_open", "live", "cancelled"],
  registration_open: ["ready", "live", "cancelled"],
  ready: ["live", "cancelled"],
  live: ["finished", "cancelled"],
  finished: [],
  cancelled: [],
};

function isActiveForStatus(status: EventStatus): boolean {
  return status !== "draft" && status !== "cancelled" && status !== "finished";
}

export async function createEvent(
  ownerId: number,
  input: {
    name: string;
    type: EventType;
    requiresBib: boolean;
    startsAt?: Date;
    endsAt?: Date;
    displayMode: DisplayMode;
    visibility: EventVisibility;
    description?: string;
    location?: string;
    area?: string;
    requiresApproval: boolean;
  },
): Promise<Event> {
  const code = await generateEventCode();
  const event = await insertEvent({
    id: randomUUID(),
    code,
    name: input.name,
    type: input.type,
    requiresBib: input.requiresBib,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    ownerId,
    displayMode: input.displayMode,
    visibility: input.visibility,
    description: input.description ?? null,
    location: input.location ?? null,
    area: input.area ?? null,
    requiresApproval: input.requiresApproval,
  });
  logger.info({ eventId: event.id, ownerId }, "event created");
  return event;
}

export type EventsFilter = "mine" | "joined" | "upcoming" | "live" | "past";

const UPCOMING_STATUSES: EventStatus[] = ["published", "registration_open", "ready"];

export async function listMyEvents(userId: number, filter: EventsFilter): Promise<Event[]> {
  const events = await selectEventsForUser(userId);
  switch (filter) {
    case "mine":
      return events.filter((event) => event.ownerId === userId);
    case "joined":
      return events.filter((event) => event.ownerId !== userId);
    case "upcoming":
      return events.filter((event) => UPCOMING_STATUSES.includes(event.status));
    case "live":
      return events.filter((event) => event.status === "live");
    case "past":
      return events.filter((event) => event.status === "finished");
    default:
      return events;
  }
}

export function listPublicEvents(limit: number, offset: number): Promise<Event[]> {
  return selectPublicEvents(limit, offset);
}

/**
 * Private events are visible only to their owner; public events to anyone, signed in or not
 * — the home screen's guest browsing reads public events without an account, and tapping
 * into one should not suddenly demand a login just to look.
 */
export async function getEventForViewer(eventId: string, viewerId: number | null): Promise<Event> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  if (event.visibility === "private" && (viewerId === null || event.ownerId !== viewerId)) {
    throw new ApiError(403, "This event is private");
  }
  return event;
}

export async function updateEventDetails(
  eventId: string,
  userId: number,
  input: UpdateEventInput,
): Promise<Event> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  // Once live, general details are locked — only the Manage view (add/remove riders,
  // pause/stop) may touch a live event, and a finished one is never editable again.
  if (event.status === "live" || event.status === "finished") {
    throw new ApiError(400, `Cannot edit event details while status is ${event.status}`);
  }

  const updated = await updateEvent(eventId, input);
  if (!updated) throw new Error(`updateEventDetails: event ${eventId} not found after update`);
  logger.info({ eventId, userId }, "event updated");
  return updated;
}

/**
 * Validates the transition graph and keeps is_active in sync. Callers that need to react to
 * a specific transition (e.g. writing participant_tracks when an event finishes) do so by
 * checking the returned event's status — see the tracking module.
 */
export async function changeEventStatus(
  eventId: string,
  userId: number,
  nextStatus: EventStatus,
): Promise<Event> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);

  const allowed = ALLOWED_STATUS_TRANSITIONS[event.status];
  if (!allowed.includes(nextStatus)) {
    throw new ApiError(400, `Cannot move an event from ${event.status} to ${nextStatus}`);
  }

  if (nextStatus === "live") {
    const limit = getMaxConcurrentLiveEvents(userId);
    const liveCount = await countLiveEventsForOwner(userId, eventId);
    if (liveCount >= limit) {
      throw new ApiError(
        409,
        `You already have ${liveCount} live events — the limit is ${limit}. Stop one first.`,
      );
    }
  }

  const finishedAt = nextStatus === "finished" ? new Date() : event.finishedAt;
  const updated = await updateEventStatus(
    eventId,
    nextStatus,
    isActiveForStatus(nextStatus),
    finishedAt,
  );
  if (!updated) throw new Error(`changeEventStatus: event ${eventId} not found after update`);
  logger.info({ eventId, userId, from: event.status, to: nextStatus }, "event status changed");
  return updated;
}

/** Soft delete: events are kept forever (plan/02-database-schema.md retention table). */
export function cancelEvent(eventId: string, userId: number): Promise<Event> {
  return changeEventStatus(eventId, userId, "cancelled");
}

/** Pause/resume only ever changes is_paused — it never touches status, and never rejects or
 * drops incoming location batches; it only freezes what GET /:eventId/live reports. */
export async function pauseEvent(eventId: string, userId: number, paused: boolean): Promise<Event> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  if (event.status !== "live") {
    throw new ApiError(400, "Only a live event can be paused or resumed");
  }
  const updated = await updateEventPaused(eventId, paused);
  if (!updated) throw new Error(`pauseEvent: event ${eventId} not found after update`);
  logger.info({ eventId, userId, paused }, "event pause toggled");
  return updated;
}

/**
 * "Effectively over" without a cron job ever touching the real status — mirrors the
 * display-only isPastDue calc EventDetailPage.tsx already does client-side, so every client
 * agrees on the same answer instead of each recomputing it slightly differently.
 */
const ONGOING_STATUSES: EventStatus[] = ["published", "registration_open", "ready", "live"];

export function computeEffectiveStatus(event: Event, now = new Date()): EventStatus {
  if (
    ONGOING_STATUSES.includes(event.status) &&
    event.endsAt &&
    event.endsAt.getTime() < now.getTime()
  ) {
    return "finished";
  }
  return event.status;
}

export const MAX_LIVE_RIDERS_FOR_VIEWER = 5;

export interface LiveRider {
  participantId: number;
  name: string;
  avatarUrl: string | null;
  bib: string | null;
  lat: number | null;
  lng: number | null;
  recordedAt: Date | null;
  emergency: boolean;
  distanceKm: number | null;
}

/**
 * The owner sees every rider, unrestricted. Anyone else must pick specific riders (at most 5
 * at a time — confirmed directly, firm) and sees nothing until they do; the server clamps
 * rather than rejecting an over-long selection so the read never fails outright.
 */
export async function getLiveRiders(
  eventId: string,
  viewerId: number | null,
  requestedRiderIds: number[] | null,
): Promise<{ riders: LiveRider[]; paused: boolean }> {
  const event = await getEventForViewer(eventId, viewerId); // 403s a private event for a stranger
  const isOwner = viewerId !== null && event.ownerId === viewerId;

  if (!isOwner) {
    if (!event.showLiveLocations) {
      throw new ApiError(403, "Live locations are not shared for this event");
    }
  }

  let riderIds: number[] | null = requestedRiderIds;
  if (!isOwner) {
    riderIds = (requestedRiderIds ?? []).slice(0, MAX_LIVE_RIDERS_FOR_VIEWER);
    if (riderIds.length === 0) {
      return { riders: [], paused: event.isPaused };
    }
  }

  const [locations, participants] = await Promise.all([
    selectLastLocationsForEvent(eventId, riderIds),
    selectParticipantsForEvent(eventId),
  ]);
  const participantById = new Map(participants.map((p) => [p.id, p]));

  // Defense in depth on top of the roster's own filtering (participants.service.ts) — a
  // non-owner viewer should never see a still-pending or rejected rider's position, even if
  // they somehow already had that participant id.
  const visibleLocations = isOwner
    ? locations
    : locations.filter((loc) => {
      const status = participantById.get(loc.participantId)?.registrationStatus;
      return status === "registered" || status === "approved";
    });

  const riders: LiveRider[] = visibleLocations.map((loc) => {
    const participant = participantById.get(loc.participantId);
    return {
      participantId: loc.participantId,
      // selectParticipantsForEvent already resolves the real name in SQL (nickname, else
      // "first last", else the manual name column) — "Rider" only fires in the genuinely
      // impossible case where all of those are blank, or the participant row is missing.
      name: participant?.name ?? "Rider",
      avatarUrl: participant?.avatarUrl ?? null,
      bib: participant?.bib ?? null,
      lat: loc.lat,
      lng: loc.lng,
      recordedAt: loc.recordedAt,
      emergency: loc.emergency,
      distanceKm: loc.distanceTravelledKm,
    };
  });

  return { riders, paused: event.isPaused };
}
