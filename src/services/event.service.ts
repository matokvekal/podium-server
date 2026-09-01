import { randomUUID } from "node:crypto";
import type {
  ActivityType,
  DisplayMode,
  Event,
  EventParticipant,
  EventStatus,
  EventType,
  EventVisibility,
  RegistrationStatus,
  RiderLevel,
} from "../db/types.js";
import { buildActor, buildEventContext, denyFeature } from "../authz/actor.js";
import { consumeFeatureCredit } from "../authz/entitlements.js";
import { assertWithinEventsPerWeek } from "../authz/limits.js";
import type { Actor, EventContext } from "../authz/policy.js";
import { canAccount, canEvent } from "../authz/policy.js";
import { ApiError } from "../lib/api-error.js";
import { haversineDistanceKm } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { selectParticipantsForEvent } from "../queries/participant.queries.js";
import { writeParticipantTracks } from "./track-writer.js";
import {
  insertEvent,
  insertLocationPoints,
  type LocationPointInput,
  insertParticipantIfRoom,
  selectActiveEventByCode,
  selectEventById,
  selectEventCodesWithPrefix,
  countEventsCreatedSince,
  type EventListItem,
  selectEventsForUser,
  selectLastLocation,
  selectLastLocationsForEvent,
  selectLiveEventForOwner,
  selectParticipantByEventAndUser,
  selectParticipantForUser,
  type PublicEventFilters,
  insertEventMember,
  selectPublicEvents,
  selectUpcomingEventsForFollowed,
  type UpdateEventInput,
  updateEvent,
  updateEventElevationGain,
  updateEventContact,
  updateEventRidePlan,
  updateEventPaused,
  updateEventStatus,
  upsertParticipant,
  upsertParticipantLastLocation,
} from "../queries/event.queries.js";
import { datePrefix, letterSuffix } from "../lib/event-code.js";

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

  if (event.requiresBib && !bib) {
    logger.warn({ eventId: event.id, userId }, "joinEvent: missing required bib");
    throw new ApiError(400, "This event requires a bib number");
  }

  const initialStatus: RegistrationStatus = event.requiresApproval
    ? "waiting_approval"
    : "registered";

  // The start-list cap is the EVENT OWNER's entitlement, not the joining rider's — a rider on
  // the free plan joining a Pro organizer's 300-person ride must not be turned away. Capacity
  // counts approved + still-pending riders (authz/participant-capacity.ts); an existing
  // participant re-joining always keeps their slot. insertParticipantIfRoom does the check and
  // the write under one per-event advisory lock so a burst of joins cannot overfill the list.
  if (event.ownerId !== null) {
    const organizer = await buildActor(event.ownerId);
    const result = await insertParticipantIfRoom({
      eventId: event.id,
      userId,
      bib,
      initialStatus,
      maxParticipants: organizer.entitlements.limits.maxParticipantsPerEvent,
    });
    if (!result.ok) {
      logger.warn(
        { eventId: event.id, userId, ...result },
        "joinEvent: rejected — ride at rider limit",
      );
      throw new ApiError(
        409,
        `This ride is full — ${result.approved + result.pending} of ${result.limit} riders (EVENT_FULL)`,
      );
    }
    logger.info(
      { eventId: event.id, userId, participantId: result.participant.id },
      "user joined event",
    );
    return { event, participant: result.participant };
  }

  // Ownerless legacy event — no entitlement to resolve, fall back to the plain idempotent join.
  const participant = await upsertParticipant({ eventId: event.id, userId, bib, initialStatus });
  logger.info({ eventId: event.id, userId, participantId: participant.id }, "user joined event");

  return { event, participant };
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

/** draft -> published -> registration_open -> ready -> live -> finished. Any non-terminal
 * state may move to cancelled. finished and cancelled are terminal.
 *
 * published -> live is the START button. POST /events now creates a published event, and the
 * product flow is create-then-start: registration_open and ready are optional stops an
 * organizer may use, not a queue every ride has to be walked through. Without this edge the
 * only way to start a ride was two extra PATCHes the client never makes. */
const ALLOWED_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["published", "cancelled"],
  published: ["registration_open", "live", "cancelled"],
  registration_open: ["ready", "cancelled"],
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
    /** "I'm riding too": also put the organizer on the start list, as themselves. */
    joinAsRider?: boolean;
    /** Defaults to "published" in createEventSchema — this product has no draft workflow. */
    status: EventStatus;
    showEventInfo?: boolean;
    showParticipants?: boolean;
    showRoute?: boolean;
    showLiveLocations?: boolean;
    showHistoryLocations?: boolean;
    showResults?: boolean;
    activityType?: ActivityType;
    level?: RiderLevel;
    organizerGroup?: string;
    /** Organizer's elevation-gain value (metres), imported from a GPX or typed. undefined =
     *  none set; null is treated the same on create. Stored in events.elevation_gain_m. */
    elevationGainM?: number | null;
    /** Organizer-set ride plan — stored in events.duration_min / rest_stops / is_accessible /
     *  has_support_vehicle via updateEventRidePlan. undefined = not set. */
    durationMin?: number | null;
    restStops?: number | null;
    isAccessible?: boolean;
    hasSupportVehicle?: boolean;
    /** Contact details the organizer chose to publish for this ride — stored in
     *  events.contact_phone / contact_email via updateEventContact. undefined = none given. */
    contactPhone?: string | null;
    contactEmail?: string | null;
  },
): Promise<Event> {
  const actor = await buildActor(ownerId);

  // Rolling 7 days rather than a calendar week — "3 this week" must not reset to zero every
  // Monday morning for someone who created 3 on Sunday.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  assertWithinEventsPerWeek(actor, await countEventsCreatedSince(ownerId, weekAgo));

  // A non-public ride is the first sellable capability. The policy answers; this code never
  // asks whether anyone is "premium", and a one-time purchase satisfies it exactly as a
  // subscription does. `registered` counts as private for this purpose only if you decide it
  // should — today it does not, since limiting a ride to signed-in riders is not organizer
  // tooling, it is a visibility preference.
  if (input.visibility === "private" && !canAccount(actor, "event:create_private")) {
    // Consumable first: someone who bought a single private ride spends it here.
    const spent = await consumeFeatureCredit(ownerId, "private_events");
    if (spent === null) {
      denyFeature("private_events", "Creating a private ride is not part of your plan");
    }
  }

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
    status: input.status,
    isActive: isActiveForStatus(input.status),
    showEventInfo: input.showEventInfo ?? null,
    showParticipants: input.showParticipants ?? null,
    showRoute: input.showRoute ?? null,
    showLiveLocations: input.showLiveLocations ?? null,
    showHistoryLocations: input.showHistoryLocations ?? null,
    showResults: input.showResults ?? null,
    activityType: input.activityType ?? null,
    level: input.level ?? null,
    organizerGroup: input.organizerGroup ?? null,
  });
  // Layer 3: the creator becomes admin OF THIS EVENT ONLY. events.owner_id stays the source
  // of truth; this row is the extensible form of it, and the only way to express an operator.
  await insertEventMember(event.id, ownerId, "owner");

  // Elevation gain is written on its own (own column, own guarded statement — see
  // updateEventElevationGain). The reply is re-read by the controller, so the returned `event`
  // not carrying it yet is fine.
  if (input.elevationGainM !== undefined && input.elevationGainM !== null) {
    await updateEventElevationGain(event.id, input.elevationGainM);
  }

  // Same story for the ride-plan columns (duration / rest stops / accessibility) — own
  // guarded statement, only touched for keys the create request actually carried.
  if (
    input.durationMin !== undefined ||
    input.restStops !== undefined ||
    input.isAccessible !== undefined ||
    input.hasSupportVehicle !== undefined
  ) {
    await updateEventRidePlan(event.id, {
      durationMin: input.durationMin,
      restStops: input.restStops,
      isAccessible: input.isAccessible,
      hasSupportVehicle: input.hasSupportVehicle,
    });
  }

  // Published contact details — its own guarded statement, separate from the ride plan on
  // purpose (see updateEventContact). Only touched when the request actually carried one.
  if (input.contactPhone !== undefined || input.contactEmail !== undefined) {
    await updateEventContact(event.id, {
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail,
    });
  }

  // Owning a ride and riding it are different things — event_members says who runs it,
  // event_participants says who is on the start list. An organizer who ticked "I'm riding
  // too" belongs in both, linked to their real user_id so the client can tell it is them.
  // Never "waiting_approval": nobody approves the owner onto their own ride.
  if (input.joinAsRider) {
    await upsertParticipant({
      eventId: event.id,
      userId: ownerId,
      bib: undefined,
      initialStatus: input.requiresApproval ? "approved" : "registered",
    });
  }

  logger.info({ eventId: event.id, ownerId, joinAsRider: !!input.joinAsRider }, "event created");
  return event;
}

export type EventsFilter = "mine" | "joined" | "upcoming" | "live" | "past" | "following";

const UPCOMING_STATUSES: EventStatus[] = ["published", "registration_open", "ready"];

export async function listMyEvents(
  userId: number,
  filter: EventsFilter,
): Promise<EventListItem[]> {
  // Asks a different question from "events I own or joined", so it gets its own query rather
  // than filtering that list down to nothing. Covers both people I follow and teams I am in —
  // a team's rides are meant to appear wherever a rider's rides normally do, so they do not
  // need a separate filter (and the client's team page deliberately shows no schedule).
  if (filter === "following") return selectUpcomingEventsForFollowed(userId);

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

/**
 * Sort default follows the bucket, because "first" means opposite things either side of today:
 * for upcoming rides the interesting end is the soonest, for finished ones the most recent.
 * The old unconditional `starts_at ASC` put the oldest ride in the database at the top of a
 * discovery list.
 */
export function listPublicEvents(
  filters: Omit<PublicEventFilters, "sort"> & { sort?: PublicEventFilters["sort"] },
): Promise<{ events: EventListItem[]; total: number }> {
  const sort = filters.sort ?? (filters.bucket === "finished" ? "latest" : "soonest");
  return selectPublicEvents({ ...filters, sort });
}

/**
 * @deprecated Superseded by the capability model in src/authz/. Kept only as the shape the
 * event controller still threads through; every actual decision now goes through
 * `canEvent()`. See AUTHORIZATION.md.
 */
export type ViewerTier = "owner" | "approved" | "pending" | "public" | "stranger";

export interface EventView {
  event: Event;
  tier: ViewerTier;
  /** Layers 1-4 of the caller, resolved once. */
  actor: Actor;
  /** Layer 3 for this event: role and participation, kept separate. */
  context: EventContext;
}

/**
 * The one place "may this person look at this event, and how much of it" is decided.
 *
 * A private event is NOT owner-only: the whole closed-ride story is that the organizer
 * shares a link or QR, riders ask to join, and an approved rider then sees the event —
 * which cannot work if anyone but the owner is turned away. So a participant row is the
 * second key, and which registration_status it carries is what separates "approved, show
 * them everything" from "still waiting, show them almost nothing".
 *
 * A stranger hitting a private event gets 404, not 403: a 403 confirms the id is real, and
 * the id is the secret being shared. A public event is readable by anyone, signed in or not
 * — guest browsing is a first-class case here, not an afterthought.
 */
export async function getEventForViewer(
  eventId: string,
  viewerId: number | null,
): Promise<EventView> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");

  const [actor, context] = await Promise.all([
    buildActor(viewerId),
    buildEventContext(event, viewerId),
  ]);

  // One question, one place. 404 rather than 403 when the answer is no: a private ride's id
  // is shared as a link or QR and IS the secret, so confirming it exists leaks it.
  if (!canEvent(actor, "event:view", context)) throw new ApiError(404, "Event not found");

  return { event, tier: toLegacyTier(context, viewerId), actor, context };
}

/** Bridge for the handful of call sites still written against the old tier vocabulary. */
function toLegacyTier(context: EventContext, viewerId: number | null): ViewerTier {
  if (context.role === "owner" || context.role === "operator") return "owner";
  if (context.participation === "approved") return "approved";
  if (context.participation === "pending") return "pending";
  return viewerId !== null ? "public" : "stranger";
}

// These two remain as named shortcuts for the controller, but the rules themselves now live
// in src/authz/policy.ts — there is exactly one implementation of each decision.
export function canViewEventInfo(view: EventView): boolean {
  return canEvent(view.actor, "event:view_details", view.context);
}

export function canViewRoute(view: EventView): boolean {
  return canEvent(view.actor, "event:view_route", view.context);
}

/** What may still be changed once a ride is live or finished — see updateEventDetails. */
const VISIBILITY_FIELDS = new Set<keyof UpdateEventInput>([
  "showEventInfo",
  "showParticipants",
  "showRoute",
  "showLiveLocations",
  "showHistoryLocations",
  "showResults",
]);

export async function updateEventDetails(
  eventId: string,
  userId: number,
  input: UpdateEventInput,
): Promise<Event> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  // Once live, the ride's DETAILS are locked — name, date, place, description. Moving those
  // out from under riders who are already on the road is the thing this guard exists to stop.
  //
  // The six show_* flags are not details, they are sharing switches, and the natural moment
  // to touch them is exactly the moment this used to forbid: after the ride, deciding to open
  // the tracks or the results. Locking them meant show_history_locations could only ever be
  // set before anyone had ridden anything, so history could never be shared retroactively.
  if (event.status === "live" || event.status === "finished") {
    const detailFields = Object.keys(input).filter(
      (key) => !VISIBILITY_FIELDS.has(key as keyof UpdateEventInput),
    );
    if (detailFields.length > 0) {
      throw new ApiError(
        400,
        `Cannot edit event details while status is ${event.status} (${detailFields.join(", ")})`,
      );
    }
  }

  const updated = await updateEvent(eventId, input);
  if (!updated) throw new Error(`updateEventDetails: event ${eventId} not found after update`);

  // Elevation gain has its own column and its own guarded statement — updateEvent above never
  // touches it. `undefined` means the caller left it out; `null` means "clear it, fall back to
  // the route".
  const wroteElevation = input.elevationGainM !== undefined;
  if (input.elevationGainM !== undefined) {
    await updateEventElevationGain(eventId, input.elevationGainM);
  }

  // Ride-plan columns — same pattern. updateEventRidePlan itself skips keys left undefined.
  const wroteRidePlan =
    input.durationMin !== undefined ||
    input.restStops !== undefined ||
    input.isAccessible !== undefined ||
    input.hasSupportVehicle !== undefined;
  if (wroteRidePlan) {
    await updateEventRidePlan(eventId, {
      durationMin: input.durationMin,
      restStops: input.restStops,
      isAccessible: input.isAccessible,
      hasSupportVehicle: input.hasSupportVehicle,
    });
  }

  // Contact details — separate guarded statement, same reason as on create.
  const wroteContact = input.contactPhone !== undefined || input.contactEmail !== undefined;
  if (wroteContact) {
    await updateEventContact(eventId, {
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail,
    });
  }

  logger.info({ eventId, userId }, "event updated");

  // `updated` came from updateEvent's RETURNING *, which ran BEFORE the two statements above —
  // so it still carries the pre-edit elevation gain and ride plan. The PATCH reply is what the
  // client merges into its ride list, so returning that row showed the OLD duration / rest
  // stops / accessibility / support-vehicle flag on the card until the next refetch. Re-read
  // once, and only when one of those separate statements actually ran.
  if (wroteElevation || wroteRidePlan || wroteContact) {
    const fresh = await selectEventById(eventId);
    if (fresh) return fresh;
  }
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

  // Asking for the state it is already in is a no-op, not an error. Now that POST /events
  // creates a published event, the client's old create-then-publish pair would otherwise 400
  // on the second call, and a retried publish (the "Event saved, but not published" banner)
  // must not fail just because the first attempt actually landed. Returning early also keeps
  // the finish hook from re-running on a finished -> finished replay.
  if (nextStatus === event.status) {
    return event;
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[event.status];
  if (!allowed.includes(nextStatus)) {
    throw new ApiError(400, `Cannot move an event from ${event.status} to ${nextStatus}`);
  }

  if (nextStatus === "live") {
    const existingLive = await selectLiveEventForOwner(userId);
    if (existingLive && existingLive.id !== eventId) {
      throw new ApiError(409, "You already have another event live — stop it first");
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

  // THE FINISH HOOK. location_points is purge-eligible and participant_tracks is never
  // purged (sql/005-tracking.sql) — this is the one moment the ride lines can still be
  // built. It runs after the status write and never throws, so a failure here cannot undo
  // the organizer finishing their ride; see writeParticipantTracks.
  if (event.status === "live" && nextStatus === "finished") {
    await writeParticipantTracks(eventId);
  }

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
 *
 * A viewer who is riding the event themselves does not spend one of those 5 on their own dot:
 * the cap is about how many OTHER people one screen may follow, and making a rider choose
 * between watching a friend and seeing where they are is not what it was for.
 */
export async function getLiveRiders(
  eventId: string,
  viewerId: number | null,
  requestedRiderIds: number[] | null,
): Promise<{ riders: LiveRider[]; paused: boolean }> {
  const { event, tier } = await getEventForViewer(eventId, viewerId); // 404s a private event for a stranger
  const isOwner = tier === "owner";

  // A rider's own position is theirs to see. show_live_locations governs whether they may see
  // EVERYONE ELSE ("see other riders if creator allows that") — it was never meant to hide a
  // rider from themselves, and doing so left a participant on an unshared ride with a blank map.
  const me =
    !isOwner && viewerId !== null ? await selectParticipantByEventAndUser(eventId, viewerId) : null;

  if (!isOwner && !event.showLiveLocations && me === null) {
    throw new ApiError(403, "Live locations are not shared for this event");
  }

  let riderIds: number[] | null = requestedRiderIds;
  if (!isOwner) {
    const others = event.showLiveLocations
      ? (requestedRiderIds ?? []).filter((id) => id !== me?.id).slice(0, MAX_LIVE_RIDERS_FOR_VIEWER)
      : [];
    riderIds = me ? [me.id, ...others] : others;
    if (riderIds.length === 0) {
      return { riders: [], paused: event.isPaused };
    }
  }

  const [locations, participants] = await Promise.all([
    selectLastLocationsForEvent(eventId, riderIds),
    selectParticipantsForEvent(eventId),
  ]);
  const participantById = new Map(participants.map((p) => [p.id, p]));

  const riders: LiveRider[] = locations.map((loc) => {
    const participant = participantById.get(loc.participantId);
    return {
      participantId: loc.participantId,
      // selectParticipantsForEvent resolves this from `users` for anyone who joined through
      // the app; "Rider" is now only reachable for a location row whose participant is gone.
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
