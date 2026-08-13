import type { Event, EventParticipant } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { logger } from "../../lib/logger.js";
import { datePrefix, letterSuffix } from "./event-code.js";
import {
  insertLocationPoints,
  type LocationPointInput,
  selectActiveEventByCode,
  selectEventCodesWithPrefix,
  selectParticipantForUser,
  upsertParticipant,
} from "./event.queries.js";

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

  const participant = await upsertParticipant({ eventId: event.id, userId, bib });
  logger.info({ eventId: event.id, userId, participantId: participant.id }, "user joined event");

  return { event, participant };
}

export async function findParticipantForUser(
  participantId: number,
  userId: number,
): Promise<EventParticipant | null> {
  return selectParticipantForUser(participantId, userId);
}

export async function saveLocationBatch(
  participantId: number,
  points: LocationPointInput[],
): Promise<number> {
  const saved = await insertLocationPoints(participantId, points);
  logger.info({ participantId, saved }, "location batch saved");
  return saved;
}
