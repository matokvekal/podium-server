import type { NextFunction, Request, Response } from "express";
import { buildActor } from "../authz/actor.js";
import { EVENT_CAPABILITIES } from "../authz/capabilities.js";
import { eventCapabilitiesFor } from "../authz/policy.js";
import type { Event, EventParticipant, User } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { traceLog } from "../lib/trace-log.js";
import { userImageFieldsOf } from "../lib/user-images.js";
import {
  countJoinedParticipants,
  type EventListItem,
  selectParticipantByEventAndUser,
} from "../queries/event.queries.js";
import { countGroupsForEvent } from "../queries/group.queries.js";
import type { RouteWithOwner } from "../queries/routeLibrary.queries.js";
import { selectUserById } from "../queries/user.queries.js";
import {
  changeEventStatusSchema,
  createEventSchema,
  eventCodeParamSchema,
  eventIdParamSchema,
  joinEventSchema,
  listEventsQuerySchema,
  liveQuerySchema,
  locationBatchSchema,
  pauseEventSchema,
  publicEventsQuerySchema,
  updateEventSchema,
} from "../schemas/event.schemas.js";
import {
  cancelEvent,
  canViewEventInfo,
  canViewRoute,
  changeEventStatus,
  computeEffectiveStatus,
  createEvent,
  type EventView,
  findActiveEventByCode,
  findParticipantForUser,
  getEventForViewer,
  getLiveRiders,
  joinEvent,
  listMyEvents,
  listPublicEvents,
  pauseEvent,
  saveLocationBatch,
  toEventConfig,
  updateEventDetails,
  type ViewerTier,
} from "../services/event.service.js";
import { getEventRouteSummary } from "../services/eventRoute.service.js";
import { toRouteSummary } from "./routeLibrary.controller.js";

function toEventSummary(event: Event | EventListItem) {
  // Present on a LIST row (EventListItem), absent when toEventDetail reuses this for a single
  // event — there the detail-specific fields below carry the same numbers.
  const summary = event as Partial<EventListItem>;
  return {
    id: event.id,
    code: event.code,
    name: event.name,
    type: event.type,
    status: event.status,
    visibility: event.visibility,
    displayMode: event.displayMode,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location,
    ownerId: event.ownerId,
    // On the SUMMARY, not just the detail: these are exactly what a rider filters and scans
    // the "Find Rides" list by, and a list must not need a detail call per card to show them.
    activityType: event.activityType,
    level: event.level,
    organizerGroup: event.organizerGroup,
    teamId: event.teamId,
    // Organizer-set ride plan — on the SUMMARY so a card fills its "Est. Time" slot, shows an
    // accessibility marker and the rest-stop count without a per-card detail call. `null` for
    // duration / restStops means "not stated" (card shows a dash / omits it); isAccessible is
    // always a real boolean. See sql/022-event-ride-plan.sql.
    durationMin: event.durationMin ?? null,
    restStops: event.restStops ?? null,
    isAccessible: event.isAccessible ?? false,
    // On the SUMMARY too, for the same reason as isAccessible: a rider scanning Find Rides
    // wants to see which rides have a vehicle behind them without opening each one.
    hasSupportVehicle: event.hasSupportVehicle ?? false,
    // Lightweight route + roster summary so a card renders Distance / Elevation / Riders
    // straight from GET /events — no per-card route or participants call, no localStorage
    // dependency. `elevationGain` is the EFFECTIVE climb (organizer's value, else the route's).
    // null / undefined here means "not known from the list" — a card shows a dash, never a 0.
    distanceKm: summary.distanceKm ?? null,
    elevationGain: summary.elevationGain ?? null,
    participantCount: summary.participantCount ?? null,
  };
}

/**
 * `tier` decides what is actually filled in, not just what the flags claim. Defaults to
 * "owner" because every other caller of this function is an owner-only mutation (create,
 * update, status, pause, cancel) that has already passed assertOwner.
 *
 * Redaction is deliberately narrow: only the fields that answer "when and where is this
 * ride" — which is exactly what an unapproved rider must not have. Name, type and status
 * stay visible for everyone, so a pending rider still sees which ride they are waiting on.
 */
function toEventDetail(
  event: Event,
  viewerId: number | null,
  myParticipant: EventParticipant | null = null,
  tier: ViewerTier = "owner",
  route: RouteWithOwner | null = null,
  owner: User | null = null,
  view: EventView | null = null,
  canSeeInfoOverride: boolean | null = null,
  capacity: {
    participantCount: number;
    maxParticipants: number;
    groupCount: number;
    maxGroups: number;
  } | null = null,
  /** `route` (the geometry preview) is nulled when false; the headline Distance / Elevation
   *  numbers below are shown regardless, exactly as the list card does. */
  canSeeRouteGeometry = true,
) {
  const canSeeInfo = canSeeInfoOverride ?? true;
  const summary = toEventSummary(event);
  return {
    ...summary,
    startsAt: canSeeInfo ? summary.startsAt : null,
    endsAt: canSeeInfo ? summary.endsAt : null,
    location: canSeeInfo ? summary.location : null,
    requiresBib: event.requiresBib,
    description: canSeeInfo ? event.description : null,
    /** What this viewer is: owner | approved | pending | public | stranger. A "pending" reader
     *  is waiting on the organizer, and the fields above are nulled for them on purpose.
     *  @deprecated read `capabilities` instead — see AUTHORIZATION.md. */
    viewerTier: tier,
    /** @deprecated equivalent to capabilities including "event:view_details". */
    canViewEventInfo: canSeeInfo,
    /**
     * THE CONTRACT WITH THE CLIENT. What this caller may do with this ride, already decided.
     * The client hides what is not in this list and never re-derives a rule; when a rule
     * changes, only the server changes. See AUTHORIZATION.md.
     */
    capabilities: view
      ? eventCapabilitiesFor(view.actor, view.context, EVENT_CAPABILITIES)
      : [...EVENT_CAPABILITIES],
    finishedAt: event.finishedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    isOwner: event.ownerId === viewerId,
    requiresApproval: event.requiresApproval,
    isPaused: event.isPaused,
    effectiveStatus: computeEffectiveStatus(event),
    showEventInfo: event.showEventInfo,
    showParticipants: event.showParticipants,
    showRoute: event.showRoute,
    showLiveLocations: event.showLiveLocations,
    showHistoryLocations: event.showHistoryLocations,
    showResults: event.showResults,
    /** Preview geometry only — the full line is GET /routes/:routeId, the same second call
     *  the browse cards make. Null when the event has no route, or this viewer may not see it. */
    route: canSeeRouteGeometry && route ? toRouteSummary(route) : null,
    /** The same effective Distance / Elevation a list card shows, so Event Detail, the Edit
     *  form and the card all read one server value. `distanceKm` is the attached route's;
     *  `elevationGain` is the organizer's elevation_gain_m, else the route's climb, else null.
     *  `route` (geometry) may be nulled for a viewer who can't see it while these stay
     *  populated — they are headline figures, not the line. */
    distanceKm: route?.distanceKm ?? null,
    elevationGain: event.elevationGainM ?? route?.elevationM ?? null,
    /** Who is running this ride. Until now the payload carried only `ownerId`, so the client
     *  displayed a fake name invented from the event id (event-visuals.ts's mockOrganizerName)
     *  — every ride in the app showed an organizer who does not exist. */
    owner: owner
      ? {
          id: owner.id,
          name:
            [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() ||
            owner.nickname ||
            null,
          // The organizer's own visual identity, read through events.owner_id — nothing is
          // copied into the event row, so changing an avatar changes it on every ride at
          // once. `avatarUrl` keeps its existing shape and now resolves to their current
          // avatar; `avatar`/`cover`/`coverUrl` are additive for clients that use them.
          ...userImageFieldsOf(owner),
        }
      : null,
    myParticipant: myParticipant
      ? {
          id: myParticipant.id,
          registrationStatus: myParticipant.registrationStatus,
          attendanceStatus: myParticipant.attendanceStatus,
        }
      : null,
    /**
     * Start-list occupancy and ride-group counts, both against the EVENT OWNER's entitlement
     * (user_entitlements folded onto their plan). `participantCount` = approved + still-pending
     * riders — the same rule the join path enforces. Additive; a client that ignores these is
     * unaffected. Defaults are the free tier (50 riders, 2 groups) when capacity was not
     * resolved for this call.
     */
    participantCount: capacity?.participantCount ?? 0,
    maxParticipants: capacity?.maxParticipants ?? null,
    isFull:
      capacity !== null ? capacity.participantCount >= capacity.maxParticipants : false,
    groupCount: capacity?.groupCount ?? 0,
    maxGroups: capacity?.maxGroups ?? null,
  };
}

/**
 * Every response that returns an event detail goes through here, so the route is present on
 * all of them. Skipping it on the mutation replies would have been one query cheaper and a
 * real bug: EventDetailPage swaps a PATCH response straight into its state, so the map would
 * vanish the moment an organizer renamed their ride.
 */
/**
 * Every response that returns an event detail goes through here, so the route, the owner and
 * the capability list are present on all of them. Skipping any of them on the mutation replies
 * would be a real bug: EventDetailPage swaps a PATCH response straight into its state, so the
 * map — or the buttons — would vanish the moment an organizer renamed their ride.
 */
async function eventDetailWithRoute(view: EventView, viewerId: number | null) {
  const { event } = view;
  const canSeeRoute = canViewRoute(view);
  const [route, owner, myParticipant, counts, groupCount, ownerActor] = await Promise.all([
    // Always fetched: the headline Distance / Elevation come from it even for a viewer who may
    // not see the geometry (same figures the list card shows everyone). The geometry preview
    // itself is gated in toEventDetail via canSeeRoute.
    getEventRouteSummary(event.id),
    event.ownerId === null ? Promise.resolve(null) : selectUserById(event.ownerId),
    viewerId === null ? Promise.resolve(null) : selectParticipantByEventAndUser(event.id, viewerId),
    countJoinedParticipants(event.id),
    countGroupsForEvent(event.id),
    // The owner's entitlement drives the caps. Reuse the viewer's actor when the viewer IS the
    // owner (the common owner-mutation reply), otherwise resolve the owner's.
    event.ownerId === null
      ? Promise.resolve(null)
      : view.actor.userId === event.ownerId
        ? Promise.resolve(view.actor)
        : buildActor(event.ownerId),
  ]);

  const limits = ownerActor?.entitlements.limits ?? null;
  const capacity = limits
    ? {
        participantCount: counts.approved + counts.pending,
        maxParticipants: limits.maxParticipantsPerEvent,
        groupCount,
        maxGroups: limits.maxGroupsPerEvent,
      }
    : null;

  return toEventDetail(
    event,
    viewerId,
    myParticipant,
    view.tier,
    route,
    owner,
    view,
    canViewEventInfo(view),
    capacity,
    canSeeRoute,
  );
}

/** Owner-only mutations already know who the caller is; re-resolve so the reply is consistent. */
async function ownerDetail(event: Event, userId: number) {
  const view = await getEventForViewer(event.id, userId);
  return eventDetailWithRoute(view, userId);
}

// GET /api/v1/events/by-code/:code
export async function getEventByCodeController(req: Request, res: Response, next: NextFunction) {
  traceLog("event.controller.getEventByCodeController", { code: req.params.code });
  try {
    const { code } = eventCodeParamSchema.parse(req.params);
    const event = await findActiveEventByCode(code);
    if (!event) {
      throw new ApiError(404, "Event not found");
    }
    res.status(200).json(toEventConfig(event));
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/join
export async function joinEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventCode, bib } = joinEventSchema.parse(req.body);
    traceLog("event.controller.joinEventController", { userId: req.auth!.userId, eventCode, bib });
    const { event, participant } = await joinEvent(req.auth!.userId, eventCode, bib);
    res.status(200).json({
      eventId: event.id,
      participantId: participant.id,
      eventName: event.name,
      eventType: event.type,
      requiresBib: event.requiresBib,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/locations/batch
export async function postLocationBatchController(req: Request, res: Response, next: NextFunction) {
  try {
    const { participantId, points } = locationBatchSchema.parse(req.body);
    traceLog("event.controller.postLocationBatchController", {
      eventId: req.params.eventId,
      participantId,
      pointCount: points.length,
    });

    const participant = await findParticipantForUser(participantId, req.auth!.userId);
    if (!participant || participant.eventId !== req.params.eventId) {
      throw new ApiError(404, "Participant not found for this event");
    }

    const saved = await saveLocationBatch(req.params.eventId, participantId, points);
    res.status(200).json({ saved });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/:eventId/live
export async function getLiveController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { riders } = liveQuerySchema.parse(req.query);
    const viewerId = req.auth?.userId ?? null;
    traceLog("event.controller.getLiveController", { eventId, viewerId, riders });
    const result = await getLiveRiders(eventId, viewerId, riders);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/pause
export async function pauseEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { paused } = pauseEventSchema.parse(req.body);
    traceLog("event.controller.pauseEventController", {
      eventId,
      userId: req.auth!.userId,
      paused,
    });
    const event = await pauseEvent(eventId, req.auth!.userId, paused);
    res.status(200).json({ data: await ownerDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events
export async function createEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createEventSchema.parse(req.body);
    traceLog("event.controller.createEventController", {
      userId: req.auth!.userId,
      name: input.name,
    });
    const event = await createEvent(req.auth!.userId, input);
    res.status(201).json({ data: await ownerDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events
export async function listEventsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { filter } = listEventsQuerySchema.parse(req.query);
    traceLog("event.controller.listEventsController", { userId: req.auth!.userId, filter });
    const events = await listMyEvents(req.auth!.userId, filter);
    res.status(200).json({ data: events.map(toEventSummary) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/public
export async function listPublicEventsController(req: Request, res: Response, next: NextFunction) {
  try {
    const filters = publicEventsQuerySchema.parse(req.query);
    traceLog("event.controller.listPublicEventsController", filters);
    const { events, total } = await listPublicEvents(filters);
    // `total` is what lets a client page correctly instead of guessing when to stop —
    // previously it had no way to know a second page existed.
    res.status(200).json({
      data: events.map(toEventSummary),
      total,
      limit: filters.limit,
      offset: filters.offset,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/:eventId
export async function getEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("event.controller.getEventController", { eventId, viewerId });
    const view = await getEventForViewer(eventId, viewerId);
    res.status(200).json({ data: await eventDetailWithRoute(view, viewerId) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId
export async function updateEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = updateEventSchema.parse(req.body);
    traceLog("event.controller.updateEventController", { eventId, userId: req.auth!.userId });
    const event = await updateEventDetails(eventId, req.auth!.userId, input);
    res.status(200).json({ data: await ownerDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/status
export async function changeEventStatusController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { status } = changeEventStatusSchema.parse(req.body);
    traceLog("event.controller.changeEventStatusController", {
      eventId,
      userId: req.auth!.userId,
      status,
    });
    const event = await changeEventStatus(eventId, req.auth!.userId, status);
    res.status(200).json({ data: await ownerDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId
export async function cancelEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("event.controller.cancelEventController", { eventId, userId: req.auth!.userId });
    const event = await cancelEvent(eventId, req.auth!.userId);
    res.status(200).json({ data: await ownerDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}
