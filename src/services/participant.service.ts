// Operator-role support (event_members.role) is milestone 3 and has no service-level
// authorization logic anywhere yet, even though the table itself exists — every mutating
// action here is owner-only until that lands. See plan/01-task-list.md milestone 3.

import { buildActor } from "../authz/actor.js";
import { hasRoomForParticipants } from "../authz/participant-capacity.js";
import { AUTO_CHECK_IN } from "../config/auto-check-in.js";
import type { AttendanceStatus, EventParticipant, ResultStatus } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { type AutoCheckInDecision, evaluateAutoCheckIn } from "../lib/auto-check-in.js";
import type { LatLng } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { countJoinedParticipants } from "../queries/event.queries.js";
import {
  deleteParticipant as deleteParticipantRow,
  insertManualParticipant,
  insertManualParticipants,
  markArrivedAutomatically,
  selectEventStartPoint,
  selectParticipantByIdForEvent,
  selectParticipantForEventUser,
  selectParticipantsForEvent,
  updateAttendanceStatus,
  updateParticipant as updateParticipantRow,
  updateRegistrationStatus,
  updateResult,
} from "../queries/participant.queries.js";
import { refreshStatsAfterAttendanceChange } from "../statistics/statistics.service.js";
import { assertOwner, getEventForViewer, type ViewerTier } from "./event.service.js";

/**
 * Owner sees everyone. Otherwise: a rider who is on the list may look — approved/registered
 * OR still waiting for approval — and only once the organizer has opened the list
 * (`show_participants`): "if riders list is open I will see, else no".
 *
 * A pending rider is included deliberately. Being on a start list and waiting to be let in
 * is the whole point of an approval ride, and a rider who cannot see the list cannot see
 * even their own row — so "you are in the queue" was unverifiable from the app. This grants
 * no approval and changes no workflow: participation stays "pending" everywhere else, and
 * every rule in authz/policy.ts that turns a pending rider away (the route, live locations,
 * history, results) is untouched.
 *
 * The tier comes back with the rows because the CALLER decides how much of each row to
 * serialize: contact details are organizer-only. See toParticipantSummary in
 * controllers/participant.controller.ts.
 */
export async function listParticipantsForViewer(
  eventId: string,
  viewerId: number | null,
): Promise<{ participants: EventParticipant[]; tier: ViewerTier }> {
  // 404s a private event for a stranger; "approved" covers "registered" too, since an event
  // needing no approval never moves anyone past it — see getEventForViewer's tier rules.
  const { event, tier } = await getEventForViewer(eventId, viewerId);
  if (tier !== "owner") {
    if (tier !== "approved" && tier !== "pending") {
      throw new ApiError(
        403,
        "Only a registered rider or the organizer may view the participants list",
      );
    }
    if (!event.showParticipants) {
      throw new ApiError(403, "The participants list is not open for this event");
    }
  }
  return { participants: await selectParticipantsForEvent(eventId), tier };
}

/**
 * The start-list cap applies however riders got onto it. It is the event OWNER's entitlement,
 * and capacity is counted the same way joinEvent counts it — approved + still-pending, never
 * rejected or left (authz/participant-capacity.ts). Callers here are owner-only, so a plain
 * read-then-check is enough; the concurrency-safe path is only needed for self-service joins.
 */
async function assertRoomForRiders(
  eventId: string,
  ownerId: number,
  adding: number,
): Promise<void> {
  const [actor, counts] = await Promise.all([
    buildActor(ownerId),
    countJoinedParticipants(eventId),
  ]);
  const max = actor.entitlements.limits.maxParticipantsPerEvent;
  if (!hasRoomForParticipants(counts, adding, max)) {
    const current = counts.approved + counts.pending;
    throw new ApiError(409, `This ride is full — ${current} of ${max} riders (EVENT_FULL)`);
  }
}

async function assertOwnerOf(eventId: string, userId: number) {
  const { event } = await getEventForViewer(eventId, userId);
  assertOwner(event, userId);
  return event;
}

export async function addParticipant(
  eventId: string,
  userId: number,
  input: {
    name: string;
    email?: string;
    phone?: string;
    category?: string;
    bib?: string;
    team?: string;
    countryCode?: string;
  },
): Promise<EventParticipant> {
  await assertOwnerOf(eventId, userId);
  await assertRoomForRiders(eventId, userId, 1);
  const participant = await insertManualParticipant(eventId, {
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    category: input.category ?? null,
    bib: input.bib ?? null,
    team: input.team ?? null,
    countryCode: input.countryCode ?? null,
  });
  logger.info({ eventId, userId, participantId: participant.id }, "participant added manually");
  return participant;
}

/** Same rules as addParticipant, once, for a whole spreadsheet. */
export async function addParticipants(
  eventId: string,
  userId: number,
  rows: {
    name: string;
    email?: string;
    phone?: string;
    category?: string;
    bib?: string;
    team?: string;
    countryCode?: string;
  }[],
): Promise<EventParticipant[]> {
  await assertOwnerOf(eventId, userId);
  // Checked for the whole file at once: importing the first 30 rows of a 60-row spreadsheet
  // and refusing the rest leaves the organizer worse off than refusing outright.
  await assertRoomForRiders(eventId, userId, rows.length);
  const created = await insertManualParticipants(
    eventId,
    rows.map((input) => ({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      category: input.category ?? null,
      bib: input.bib ?? null,
      team: input.team ?? null,
      countryCode: input.countryCode ?? null,
    })),
  );
  logger.info({ eventId, userId, count: created.length }, "participants imported");
  return created;
}

export async function editParticipant(
  eventId: string,
  userId: number,
  participantId: number,
  input: {
    name?: string;
    email?: string;
    phone?: string;
    category?: string;
    bib?: string;
    team?: string;
    countryCode?: string;
  },
): Promise<EventParticipant> {
  await assertOwnerOf(eventId, userId);
  const updated = await updateParticipantRow(participantId, eventId, input);
  if (!updated) throw new ApiError(404, "Participant not found for this event");
  return updated;
}

export async function removeParticipant(
  eventId: string,
  userId: number,
  participantId: number,
): Promise<void> {
  await assertOwnerOf(eventId, userId);
  const removed = await deleteParticipantRow(participantId, eventId);
  if (!removed) throw new ApiError(404, "Participant not found for this event");
  logger.info({ eventId, userId, participantId }, "participant removed");
}

async function setRegistrationStatus(
  eventId: string,
  userId: number,
  participantId: number,
  status: "approved" | "rejected",
): Promise<EventParticipant> {
  await assertOwnerOf(eventId, userId);
  const existing = await selectParticipantByIdForEvent(participantId, eventId);
  if (!existing) throw new ApiError(404, "Participant not found for this event");
  const updated = await updateRegistrationStatus(participantId, eventId, status);
  if (!updated)
    throw new Error(`setRegistrationStatus: participant ${participantId} not found after update`);
  logger.info({ eventId, userId, participantId, status }, "registration status changed");
  return updated;
}

export function approveParticipant(
  eventId: string,
  userId: number,
  participantId: number,
): Promise<EventParticipant> {
  return setRegistrationStatus(eventId, userId, participantId, "approved");
}

export function rejectParticipant(
  eventId: string,
  userId: number,
  participantId: number,
): Promise<EventParticipant> {
  return setRegistrationStatus(eventId, userId, participantId, "rejected");
}

/**
 * "Who actually turned up" — the organizer ticking riders off at the start, and the safety
 * check afterwards. A separate axis from registration and from the result: a rider can be
 * approved, present and finished all at once.
 */
export async function setAttendance(
  eventId: string,
  userId: number,
  participantId: number,
  status: AttendanceStatus,
): Promise<EventParticipant> {
  const event = await assertOwnerOf(eventId, userId);
  const updated = await updateAttendanceStatus(participantId, eventId, status);
  if (!updated) throw new ApiError(404, "Participant not found for this event");
  logger.info({ eventId, userId, participantId, status }, "attendance status changed");
  // A tick or un-tick after the ride finished changes whether it counts for that rider (only
  // while stats_require_live_checkin is on — the statistics side decides). Before the finish
  // nothing is needed: the finish hook computes everything from scratch.
  if (event.status === "finished" && updated.userId !== null) {
    await refreshStatsAfterAttendanceChange(eventId, updated.userId);
  }
  return updated;
}

/**
 * What an auto check-in attempt came to. The geometry/time outcomes come from evaluateAutoCheckIn
 * (lib/auto-check-in.ts); the rest are about the rider's own row and are decided before any
 * position is looked at.
 *
 *   arrived            this call marked the rider
 *   already_recorded   attendance was already something other than `unknown` — nothing to do
 *   organizer_decided  an organizer un-ticked this rider; the app must not tick them back
 *   not_approved       still waiting for approval, rejected, or has left the ride
 *
 * Returned as data, not thrown: "not there yet" is the NORMAL answer for most attempts, and
 * a 4xx for it would put an error in every rider's console each time the app opens early.
 */
export type AutoCheckInOutcome =
  | AutoCheckInDecision
  | "already_recorded"
  | "organizer_decided"
  | "not_approved";

export interface AutoCheckInAttempt {
  outcome: AutoCheckInOutcome;
  /** Metres from the start point, when one was measured. */
  distanceM: number | null;
  participant: EventParticipant;
}

/**
 * The rider's own "I am here" — sets attendance to present, attendance_source to 'auto'.
 *
 * SERVER IS THE AUTHORITY. The client decides only WHEN to ask for a GPS fix (so it does not
 * prompt for location a week before a ride); every rule — the switch, the time window, the
 * distance, the accuracy — is checked here against config/auto-check-in.ts, and nothing the
 * client claims about itself except the fix is believed. A fix can of course be spoofed by
 * someone determined to; the organizer's manual override is the answer to that, not more
 * client code.
 *
 * Only an approved (or `registered`) rider on the start list may check in: the same tier that
 * gets the route and live map, and deliberately not "anyone who can see the ride".
 */
export async function autoCheckIn(
  eventId: string,
  userId: number,
  fix: { position: LatLng; accuracyM?: number },
): Promise<AutoCheckInAttempt> {
  const { event } = await getEventForViewer(eventId, userId);

  const participant = await selectParticipantForEventUser(eventId, userId);
  if (!participant) {
    throw new ApiError(403, "Only a rider on this ride's start list can check in");
  }
  const approved =
    participant.registrationStatus === "approved" ||
    participant.registrationStatus === "registered";
  if (!approved || participant.leftAt !== null) {
    return { outcome: "not_approved", distanceM: null, participant };
  }

  // Nothing to prove if attendance is already on record, and no reason to read the route.
  if (participant.attendanceStatus !== "unknown") {
    return { outcome: "already_recorded", distanceM: null, participant };
  }
  // `unknown` with a source is an organizer's un-tick (updateAttendanceStatus stamps 'manual').
  if (participant.attendanceSource !== null) {
    return { outcome: "organizer_decided", distanceM: null, participant };
  }

  const { decision, distanceM } = evaluateAutoCheckIn(
    {
      autoCheckIn: event.autoCheckIn,
      status: event.status,
      startsAt: event.startsAt,
      // No route read for a ride that has the feature switched off.
      startPoint: event.autoCheckIn ? await selectEventStartPoint(eventId) : null,
      now: new Date(),
      position: fix.position,
      accuracyM: fix.accuracyM,
    },
    AUTO_CHECK_IN,
  );
  if (decision !== "arrived") return { outcome: decision, distanceM, participant };

  const updated = await markArrivedAutomatically(participant.id, eventId);
  if (!updated) {
    // The guard held: an organizer (or a second request of ours) wrote attendance between the
    // read above and this write. Report what is on record now rather than claiming we did it.
    const current = (await selectParticipantForEventUser(eventId, userId)) ?? participant;
    return { outcome: "already_recorded", distanceM, participant: current };
  }
  logger.info(
    { eventId, userId, participantId: participant.id, distanceM },
    "rider checked in automatically",
  );
  return { outcome: "arrived", distanceM, participant: updated };
}

/**
 * "Did they make it back" — asked for as a plain safety check, not a timing system.
 *
 * finished_at defaults to now on a "finished" call, because the real use is an organizer
 * tapping riders in as they arrive. Any status other than "finished" clears both the time
 * and the position: a rider corrected to DNF who kept a finish time would stay in the
 * results ranking forever.
 */
export async function setResult(
  eventId: string,
  userId: number,
  participantId: number,
  input: { status: ResultStatus; finishedAt?: Date; finishPosition?: number },
): Promise<EventParticipant> {
  await assertOwnerOf(eventId, userId);
  const finished = input.status === "finished";
  const updated = await updateResult(participantId, eventId, {
    status: input.status,
    finishedAt: finished ? (input.finishedAt ?? new Date()) : null,
    finishPosition: finished ? (input.finishPosition ?? null) : null,
  });
  if (!updated) throw new ApiError(404, "Participant not found for this event");
  logger.info({ eventId, userId, participantId, status: input.status }, "result status changed");
  return updated;
}
