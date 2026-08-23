// Operator-role support (event_members.role) is milestone 3 and has no service-level
// authorization logic anywhere yet, even though the table itself exists — every mutating
// action here is owner-only until that lands. See plan/01-task-list.md milestone 3.

import type {
  AttendanceStatus,
  EventParticipant,
  ResultStatus,
} from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { buildActor } from "../authz/actor.js";
import { assertWithinParticipantLimit } from "../authz/limits.js";
import { assertOwner, getEventForViewer, type ViewerTier } from "./event.service.js";
import {
  deleteParticipant as deleteParticipantRow,
  insertManualParticipant,
  insertManualParticipants,
  selectParticipantByIdForEvent,
  selectParticipantsForEvent,
  updateAttendanceStatus,
  updateParticipant as updateParticipantRow,
  updateRegistrationStatus,
  updateResult,
} from "../queries/participant.queries.js";

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

/** The plan cap applies to the whole start list, however riders got onto it. */
async function assertRoomForRiders(
  eventId: string,
  userId: number,
  adding: number,
): Promise<void> {
  const [actor, current] = await Promise.all([
    buildActor(userId),
    selectParticipantsForEvent(eventId),
  ]);
  assertWithinParticipantLimit(actor, current.length, adding);
}

async function assertOwnerOf(eventId: string, userId: number): Promise<void> {
  const { event } = await getEventForViewer(eventId, userId);
  assertOwner(event, userId);
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
  await assertOwnerOf(eventId, userId);
  const updated = await updateAttendanceStatus(participantId, eventId, status);
  if (!updated) throw new ApiError(404, "Participant not found for this event");
  logger.info({ eventId, userId, participantId, status }, "attendance status changed");
  return updated;
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
