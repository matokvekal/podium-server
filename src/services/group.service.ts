// Ride groups: one event ridden as 2-4 groups at once (e.g. "Beginners" and "Elite"), each
// optionally with its own start time and its own track.
//
// NOT a results concept. event_participants.category is "which class am I scored in"; a group
// is "who am I riding with". A club running one Saturday ride at two paces has one event with
// two groups, and nobody is placed against the other group.

import type { EventGroup } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { buildActor } from "../authz/actor.js";
import { assertWithinGroupLimit } from "../authz/limits.js";
import { selectEventById } from "../queries/event.queries.js";
import { assertOwner, getEventForViewer } from "./event.service.js";
import { selectParticipantsForEvent } from "../queries/participant.queries.js";
import { getRouteForViewer } from "./routeLibrary.service.js";
import {
  assignParticipantsToGroup,
  countGroupsForEvent,
  deleteGroup,
  insertGroup,
  selectGroupById,
  selectGroupIdsForEvent,
  selectGroupsForEvent,
  updateGroup,
} from "../queries/group.queries.js";

async function assertEventOwner(eventId: string, userId: number) {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  return event;
}

/**
 * Groups are read by whoever may read the event's participants — they are the start list
 * split up, so they cannot be more open than it is.
 */
export async function listGroupsForViewer(
  eventId: string,
  viewerId: number | null,
): Promise<EventGroup[]> {
  const { event, tier } = await getEventForViewer(eventId, viewerId);
  if (tier !== "owner") {
    if (tier !== "approved") {
      throw new ApiError(403, "Only a registered rider or the organizer may view ride groups");
    }
    if (!event.showParticipants) {
      throw new ApiError(403, "The riders list is not open for this event");
    }
  }
  return selectGroupsForEvent(eventId);
}

export async function createGroup(
  eventId: string,
  userId: number,
  input: { name: string; startsAt?: Date; routeId?: number },
): Promise<EventGroup> {
  await assertEventOwner(eventId, userId);

  const [actor, existing] = await Promise.all([
    buildActor(userId),
    countGroupsForEvent(eventId),
  ]);
  assertWithinGroupLimit(actor, existing);

  // A group's own track must be one the organizer may actually read — their own, or published.
  if (input.routeId !== undefined) await getRouteForViewer(input.routeId, userId);

  const group = await insertGroup({
    eventId,
    name: input.name,
    startsAt: input.startsAt ?? null,
    routeId: input.routeId ?? null,
    // New groups go on the end; the client reorders explicitly with sortOrder.
    sortOrder: existing,
  });
  logger.info({ eventId, userId, groupId: group.id }, "ride group created");
  return group;
}

export async function editGroup(
  eventId: string,
  userId: number,
  groupId: number,
  input: {
    name?: string;
    startsAt?: Date | null;
    routeId?: number | null;
    sortOrder?: number;
  },
): Promise<EventGroup> {
  await assertEventOwner(eventId, userId);
  if (typeof input.routeId === "number") await getRouteForViewer(input.routeId, userId);

  // An explicit null means "clear it" — a group with no start time rides with the event, and
  // a group with no route uses the event's. Both are real answers, not absences.
  const updated = await updateGroup(groupId, eventId, {
    name: input.name,
    startsAt: input.startsAt ?? undefined,
    routeId: input.routeId ?? undefined,
    sortOrder: input.sortOrder,
    clearStartsAt: input.startsAt === null,
    clearRouteId: input.routeId === null,
  });
  if (!updated) throw new ApiError(404, "Ride group not found for this event");
  return updated;
}

export async function removeGroup(
  eventId: string,
  userId: number,
  groupId: number,
): Promise<void> {
  await assertEventOwner(eventId, userId);
  const existing = await selectGroupById(groupId, eventId);
  if (!existing) throw new ApiError(404, "Ride group not found for this event");
  await deleteGroup(groupId, eventId);
  logger.info({ eventId, userId, groupId }, "ride group removed");
}

/**
 * Move riders into a group, or out of every group with `groupId: null`.
 *
 * Validates the whole list before writing: a partly-applied assignment would leave the
 * organizer's screen disagreeing with the server about who is where, which is worse than a
 * refusal they can act on.
 */
export async function assignRiders(
  eventId: string,
  userId: number,
  participantIds: number[],
  groupId: number | null,
): Promise<number> {
  await assertEventOwner(eventId, userId);

  if (groupId !== null) {
    const groupIds = await selectGroupIdsForEvent(eventId);
    if (!groupIds.includes(groupId)) {
      throw new ApiError(404, "Ride group not found for this event");
    }
  }

  const known = new Set((await selectParticipantsForEvent(eventId)).map((p) => p.id));
  const unknown = participantIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ApiError(400, `Not participants of this event: ${unknown.join(", ")}`);
  }

  const assigned = await assignParticipantsToGroup(eventId, participantIds, groupId);
  logger.info({ eventId, userId, groupId, count: assigned }, "riders assigned to ride group");
  return assigned;
}
