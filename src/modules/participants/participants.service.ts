// Operator-role support (event_members.role) is milestone 3 and has no service-level
// authorization logic anywhere yet, even though the table itself exists — every mutating
// action here is owner-only until that lands. See plan/01-task-list.md milestone 3.

import type { EventParticipant } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { logger } from "../../lib/logger.js";
import { selectParticipantByEventAndUser } from "../events/event.queries.js";
import { assertOwner, getEventForViewer } from "../events/event.service.js";
import {
  deleteParticipant as deleteParticipantRow,
  insertManualParticipant,
  selectParticipantByIdForEvent,
  selectParticipantsForEvent,
  updateParticipant as updateParticipantRow,
  updateRegistrationStatus,
} from "./participants.queries.js";

/**
 * Owner sees everyone. Otherwise: only a registered/approved rider may look, and only once
 * the organizer has opened the list (`show_participants`) — mirrors "if riders list is open I
 * will see, else no" from the product ask.
 */
export async function listParticipantsForViewer(
  eventId: string,
  viewerId: number | null,
): Promise<EventParticipant[]> {
  const event = await getEventForViewer(eventId, viewerId); // 403s a private event for a stranger
  const isOwner = viewerId !== null && event.ownerId === viewerId;
  if (!isOwner) {
    const myParticipant =
      viewerId !== null ? await selectParticipantByEventAndUser(eventId, viewerId) : null;
    const isRegistered =
      myParticipant !== null &&
      (myParticipant.registrationStatus === "registered" ||
        myParticipant.registrationStatus === "approved");
    if (!isRegistered) {
      throw new ApiError(
        403,
        "Only a registered rider or the organizer may view the participants list",
      );
    }
    if (!event.showParticipants) {
      throw new ApiError(403, "The participants list is not open for this event");
    }
  }
  return selectParticipantsForEvent(eventId);
}

async function assertOwnerOf(eventId: string, userId: number): Promise<void> {
  const event = await getEventForViewer(eventId, userId);
  assertOwner(event, userId);
}

export async function addParticipant(
  eventId: string,
  userId: number,
  input: { name: string; email?: string; phone?: string; category?: string; bib?: string },
): Promise<EventParticipant> {
  await assertOwnerOf(eventId, userId);
  const participant = await insertManualParticipant(eventId, {
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    category: input.category ?? null,
    bib: input.bib ?? null,
  });
  logger.info({ eventId, userId, participantId: participant.id }, "participant added manually");
  return participant;
}

export async function editParticipant(
  eventId: string,
  userId: number,
  participantId: number,
  input: { name?: string; email?: string; phone?: string; category?: string; bib?: string },
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
