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
  linkGroupBodySchema,
  listEventsQuerySchema,
  liveQuerySchema,
  locationBatchSchema,
  pauseEventSchema,
  publicEventsQuerySchema,
  shareCodesParamSchema,
  updateEventSchema,
} from "../schemas/event.schemas.js";
import {
  cancelEvent,
  canViewEventInfo,
  canViewRoute,
  changeEventStatus,
  clearEventLinkGroup,
  computeEffectiveStatus,
  createEvent,
  type EventView,
  findActiveEventByCode,
  findParticipantForUser,
  getEventForViewer,
  getLinkedRidesForViewer,
  getLiveRiders,
  getSharedRideGroup,
  joinEvent,
  leaveEvent,
  listMyEvents,
  listPublicEventAreas,
  listPublicEvents,
  pauseEvent,
  type SharedRideMember,
  saveLocationBatch,
  setEventLinkGroup,
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
    // Free-text region/area (sql/009-events-area.sql). On the SUMMARY so the edit form
    // prefills it, the "Find Rides" list can sort by it, and a card can show it — the
    // client already sends it on create/PATCH and reads it back here.
    area: event.area,
    // The ride's country (2-letter) and coarse region key (sql/030-country.sql). The
    // "Browse tracks" picker filters on both; a card shows the region label. `region` null
    // means the organiser has not set one.
    country: event.country ?? null,
    region: event.region ?? null,
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
    // How technical the ground is, 1-5 (sql/038). On the SUMMARY because the whole point is
    // that a rider scanning Find Rides can see it without opening each ride. The WORDS are the
    // client's (mtb S1-S5, gravel G1-G5); the number is all the API commits to.
    // null = not stated, and a card shows a dash rather than inventing a 1.
    terrainGrade: event.terrainGrade ?? null,
    // On the SUMMARY too, for the same reason as isAccessible: a rider scanning Find Rides
    // wants to see which rides have a vehicle behind them without opening each one.
    hasSupportVehicle: event.hasSupportVehicle ?? false,
    // On the SUMMARY because the app decides from My Rides — before any detail is opened —
    // whether it is worth asking for a GPS fix when a ride is about to start (sql/040). The
    // radius and time window are server config and are deliberately not sent.
    autoCheckIn: event.autoCheckIn ?? false,
    // The organizer's expected head-count, or null when they left it blank. On the SUMMARY so a
    // card can show "12 / 40" without a detail call. NOT the capacity — the plan's
    // participants-per-event ceiling is never serialised to a viewer.
    expectedParticipants: event.expectedParticipants ?? null,
    // Lightweight route + roster summary so a card renders Distance / Elevation / Riders
    // straight from GET /events — no per-card route or participants call, no localStorage
    // dependency. `elevationGain` is the EFFECTIVE climb (organizer's value, else the route's).
    // null / undefined here means "not known from the list" — a card shows a dash, never a 0.
    distanceKm: summary.distanceKm ?? null,
    elevationGain: summary.elevationGain ?? null,
    participantCount: summary.participantCount ?? null,
    // How many rides have been built on the attached route — only GET /events/public fills
    // this in (its copy_summary lateral); null everywhere else, and the card falls back to
    // its per-card ?preview=1 fetch.
    downloads: summary.downloads ?? null,
    // The ATTACHED TRACK's id. On the summary because likes and favourites belong to the
    // track, not the ride: a card has to know which routes.id to POST to, and which rides
    // share one count. null when the ride has no route.
    routeId: summary.routeId ?? null,
    // The organizer's display name, resolved server-side through events.owner_id the same way
    // a participant's is (PARTICIPANT_DISPLAY_COLUMNS). The track card shows "Created by" and
    // used to print a placeholder because the list served ownerId and no name.
    ownerName: summary.ownerName ?? null,
    // Which /share link group this ride belongs to, or null when it is shared on its own
    // (sql/037). On the SUMMARY so the organizer's "Created" list can mark the rides that
    // share a link without a detail call per card. The group's MEMBERS are not here — that is
    // the detail payload's linkedRides, because a list card has no use for them.
    linkGroupId: event.linkGroupId ?? null,
    // Likes on the attached TRACK, shared by every ride built on it (sql/036). As with
    // downloads, only GET /events/public fills these in. `likedByMe` / `favoritedByMe` are
    // null for a signed-out viewer — not false, which would claim they had not liked it.
    likes: summary.likes ?? null,
    likedByMe: summary.likedByMe ?? null,
    favoritedByMe: summary.favoritedByMe ?? null,
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
/** Exported as a test seam — controllers/event.controller.test.ts pins the owner-only
 *  redaction of the account ceilings, which is a privacy rule and not an implementation
 *  detail. Nothing outside this module and that test should call it. */
export function toEventDetail(
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
  /** The other rides sharing this ride's /share link, already filtered to the ones this
   *  viewer may see (event.service.ts::getLinkedRidesForViewer). Empty for the normal case. */
  linkedRides: Event[] = [],
) {
  const canSeeInfo = canSeeInfoOverride ?? true;
  // Decided once: it answers `isOwner` AND gates the account ceilings below, and those two must
  // never disagree — a viewer told `isOwner: false` who still receives a cap is the leak this
  // guards against.
  const viewerIsOwner = event.ownerId === viewerId;
  const summary = toEventSummary(event);
  return {
    ...summary,
    startsAt: canSeeInfo ? summary.startsAt : null,
    endsAt: canSeeInfo ? summary.endsAt : null,
    location: canSeeInfo ? summary.location : null,
    area: canSeeInfo ? summary.area : null,
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
    isOwner: viewerIsOwner,
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
    /**
     * Where this ride's track came from — sql/025-track-copy-lineage.sql. Both null for a track
     * uploaded or drawn; route id only for one picked out of Find Tracks, where there is no
     * source ride.
     *
     * On the DETAIL payload, not the summary: it is a line on the ride's own page, not
     * something a list card shows. Deliberately not gated on canSeeInfo — crediting whose ride
     * a track came from is the point, and it reveals nothing the track itself does not.
     *
     * `copiedFromEventId` may name a ride that is gone. That is a normal end state, not a
     * dangling reference: the ride and the track are separate entities and the record outlives
     * the ride. The client renders the credit as plain text when it no longer resolves.
     */
    copiedFromEventId: event.copiedFromEventId ?? null,
    copiedFromRouteId: event.copiedFromRouteId ?? null,
    /**
     * The OTHER rides sharing this ride's one /share link (sql/037) — what the ride page's
     * "1 of 2 rides that day · Switch ride" chip is built from. Empty for a ride shared on its
     * own, which is almost every ride.
     *
     * Sent as part of the ride rather than left to the client to remember, so the chip
     * survives a refresh and appears even for someone who opened this ride's page directly
     * instead of coming through the shared link.
     *
     * Already filtered to what this viewer may see, so the chip can never count a ride the
     * chooser would then refuse to show. Just enough per sibling to render a link and a label
     * — the chooser itself fetches the full cards.
     */
    linkedRides: linkedRides.map((ride) => ({
      eventId: ride.id,
      code: ride.code,
      name: ride.name,
      startsAt: ride.startsAt,
    })),
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
          // 'auto' | 'manual' | null — lets a rider's own screen say how they were checked in.
          attendanceSource: myParticipant.attendanceSource ?? null,
        }
      : null,
    /**
     * Start-list occupancy, against the EVENT OWNER's entitlement. `participantCount` =
     * approved + still-pending riders — the same rule the join path enforces — and it is the
     * ONE number every viewer gets. Additive; a client that ignores these is unaffected.
     *
     * ⚠ THE CEILINGS ARE OWNER-ONLY. `maxParticipants` / `maxGroups` are the organizer's
     * account cap (user_limits.participants_per_event, default 50). The organizer sees
     * "6 / 50" on their own ride; every other viewer sees "7" and no denominator — how much
     * room an organizer's plan gives them is nobody else's business. So these are null unless
     * the viewer IS the owner, and this is a redaction, not a default: do not "fix" a null on
     * the client by substituting a fallback ceiling (see EventDetailPage's eventFull).
     *
     * `isFull` stays visible to everyone deliberately — a rider has to know they cannot join,
     * and a boolean says that without naming the cap.
     */
    participantCount: capacity?.participantCount ?? 0,
    maxParticipants: viewerIsOwner ? (capacity?.maxParticipants ?? null) : null,
    isFull: capacity !== null ? capacity.participantCount >= capacity.maxParticipants : false,
    groupCount: capacity?.groupCount ?? 0,
    maxGroups: viewerIsOwner ? (capacity?.maxGroups ?? null) : null,
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

  // Not in the Promise.all above: it is skipped entirely for an ungrouped ride (the normal
  // case), so folding it in would add a round trip to every single event read.
  const linkedRides = await getLinkedRidesForViewer(event, viewerId);

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
    linkedRides,
  );
}

/** Owner-only mutations already know who the caller is; re-resolve so the reply is consistent. */
async function ownerDetail(event: Event, userId: number) {
  const view = await getEventForViewer(event.id, userId);
  return eventDetailWithRoute(view, userId);
}

// ---- link groups: one /share link over several rides (sql/037) ----------------------------

/**
 * One member of a shared link, as the chooser's card needs it.
 *
 * Built on toEventSummary so a card here shows the same Distance / Elevation / Riders a card
 * anywhere else in the app does — then redacted for a viewer who may not see the ride's
 * details, nulling exactly the four fields toEventDetail nulls for the same reason. A private
 * ride therefore gives a stranger a name-and-type card: precisely what its own code already
 * discloses through toEventConfig, and nothing more.
 */
function toSharedRideCard(member: SharedRideMember) {
  const summary = toEventSummary(member.event);
  if (member.canSeeInfo) return summary;
  return { ...summary, startsAt: null, endsAt: null, location: null, area: null };
}

/**
 * The line drawn on a chooser card, IN THIS PAYLOAD rather than fetched per card.
 *
 * ⚠ WHY IT CANNOT BE LEFT TO GET /events/:id/route
 *   That endpoint gates on getEventForViewer, so for a PRIVATE ride — the default — it answers
 *   404 to exactly the person this link was sent to. The chooser asked for three maps, got
 *   three refusals, and every card sat on a spinner. Moving the read here puts it behind the
 *   same decision that listed the ride in the first place: holding the link is what entitles
 *   the reader to the card, map included, and `canSeeInfo` is that decision.
 *
 * THE THINNED LINE, NOT THE ROUTE
 *   `previewPoints` is what the browse cards already draw (routeLibrary ROUTE_SUMMARY_COLUMNS).
 *   The full geometry runs to ~116 KB per ride — three of those inline would hold the whole
 *   chooser back behind a third of a megabyte to draw three thumbnails 320px wide.
 *
 * Shaped as the client's EventRoute (`points` / `distanceKm` / `elevationM`) so the cards keep
 * rendering through exactly the code they already did. A ride with no track, or a track stored
 * without a preview line, is null — a card with no map, which is a normal state here.
 *
 * ⚠ THE POINTS GO THROUGH toRouteSummary, NEVER STRAIGHT OUT OF THE ROW.
 *   A stored preview line is [lat, lng] pairs for some routes and {lat, lng, ele} objects for
 *   others (splitStoredGeometry reads both). Only the tuple form is the wire format, and
 *   handing the object form to a client that projects `[lat, lng]` draws nothing at all —
 *   silently, which is the worst way for a map to be wrong.
 */
async function toSharedRideRoute(member: SharedRideMember) {
  if (!member.canSeeInfo) return null;
  const route = await getEventRouteSummary(member.event.id);
  if (!route) return null;
  const points = toRouteSummary(route).previewPoints;
  // Two points is the minimum that can be drawn as a line; one is a dot the reader cannot read
  // anything from, and the client already treats a short list as no map.
  if (points === null || points.length < 2) return null;
  return { points, distanceKm: route.distanceKm, elevationM: route.elevationM };
}

/** Each card plus its line, in the order the service resolved them (earliest start first).
 *
 *  Exported as a test seam — controllers/event.controller.linkGroup.test.ts pins that a
 *  redacted member gets no map, which is a privacy rule and not an implementation detail. */
export async function mapSharedRideCards(members: SharedRideMember[]) {
  const cards = [];
  for (const member of members) {
    cards.push({ ...toSharedRideCard(member), route: await toSharedRideRoute(member) });
  }
  return cards;
}

// GET /api/v1/events/share/:codes
export async function getSharedRidesController(req: Request, res: Response, next: NextFunction) {
  try {
    const { codes } = shareCodesParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("event.controller.getSharedRidesController", { codes, viewerId });
    const group = await getSharedRideGroup(codes, viewerId);

    // The owner is resolved ONCE, not per card: one owner per group is a write-time invariant
    // (event.service.ts::setEventLinkGroup), so the chooser's "<Owner> created 2 rides" line
    // cannot differ between members. Read from the first member, which is the earliest start.
    const ownerId = group.members[0].event.ownerId;
    const owner = ownerId === null ? null : await selectUserById(ownerId);

    res.status(200).json({
      data: {
        /** Null when none of the codes is in a group any more — the client then treats what it
         *  got as plain rides rather than as a set, and a single ride redirects to /join. */
        linkGroupId: group.linkGroupId,
        owner: owner
          ? {
              id: owner.id,
              name:
                [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() ||
                owner.nickname ||
                null,
              ...userImageFieldsOf(owner),
            }
          : null,
        // Sequential rather than Promise.all: at most three members, each one query, and the
        // pool is shared with every other request on this server.
        rides: await mapSharedRideCards(group.members),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events/share  — no codes.
 *
 * Registered only so this answers something a person can act on. Without it the request falls
 * through to GET /:eventId, where eventIdParamSchema rejects "share" as a non-UUID and the
 * caller gets a 400 about an event id they never mentioned.
 */
export function getSharedRidesIndexController(_req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(400, "That share link is missing its ride codes"));
}

// PUT /api/v1/events/:eventId/link-group
export async function setLinkGroupController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { eventIds } = linkGroupBodySchema.parse(req.body);
    traceLog("event.controller.setLinkGroupController", {
      eventId,
      userId: req.auth!.userId,
      eventIds,
    });
    const rides = await setEventLinkGroup(eventId, req.auth!.userId, eventIds);
    // The whole group back, as summaries: the sheet redraws from this, and the share sheet
    // needs every member's CODE to build the /share/<a>-<b> URL.
    res.status(200).json({ data: { rides: rides.map(toEventSummary) } });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/link-group
export async function clearLinkGroupController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("event.controller.clearLinkGroupController", { eventId, userId: req.auth!.userId });
    const rides = await clearEventLinkGroup(eventId, req.auth!.userId);
    res.status(200).json({ data: { rides: rides.map(toEventSummary) } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/events/:eventId/leave
 *
 * The rider takes themselves off a start list. The client has called this for a long time
 * against nothing at all — see event.service.ts::leaveEvent for that story.
 *
 * Answers 200 with the ride, not 204: the client refetches the ride afterwards anyway, and
 * handing it back saves the round trip. Leaving a ride you already left is also a 200 — the
 * rider asked to be off the list and they are off the list.
 */
export async function leaveEventController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("event.controller.leaveEventController", { eventId, userId: req.auth!.userId });
    await leaveEvent(eventId, req.auth!.userId);
    const view = await getEventForViewer(eventId, req.auth!.userId);
    res.status(200).json({ data: await eventDetailWithRoute(view, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
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
    // Guests keep the whole list. A signed-out caller asking for favoritesOnly gets every
    // track rather than a 401 or an empty grid — they have no favourites to filter to, and the
    // page must still render for them. The client hides the toggle when signed out anyway.
    const viewerId = req.auth?.userId;
    const { events, total } = await listPublicEvents({
      ...filters,
      viewerId,
      favoritesOnly: viewerId ? filters.favoritesOnly : false,
    });
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

// GET /api/v1/events/public/areas
export async function listPublicEventAreasController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    traceLog("event.controller.listPublicEventAreasController", {});
    const areas = await listPublicEventAreas();
    res.status(200).json({ data: { areas } });
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
