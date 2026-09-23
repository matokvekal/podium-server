// The RIDE CHAT — one shared text conversation per ride (sql/047-ride-chat.sql).
//
// Access is the ride's own authorization, nothing new: getEventForViewer answers "does this
// ride exist for you" (404 if not — a private ride's id is its secret), and policy.ts
// "event:chat" answers "are you on it" (403 if not). Both are checked on every read AND write.
//
// The client sends only the text. Who wrote it, under what name, with what badge and at what
// time are all decided here and in the database.

import { canEvent } from "../authz/policy.js";
import {
  RIDE_CHAT_MAX_MESSAGE_LENGTH,
  RIDE_CHAT_MAX_MESSAGES_PER_RIDE,
  RIDE_CHAT_MAX_SUMMARY_RIDES,
  RIDE_CHAT_UNREAD_CAP,
} from "../config/ride-chat.js";
import { ApiError } from "../lib/api-error.js";
import {
  insertRideChatMessage,
  type RideChatMessageRow,
  selectRideChatMessages,
  selectUnreadSummary,
} from "../queries/rideChat.queries.js";
import { getEventForViewer } from "./event.service.js";

export interface RideChatMessage {
  id: number;
  userId: number;
  userName: string | null;
  isOrganizer: boolean;
  text: string;
  createdAt: string;
}

export interface RideChatLimits {
  maxMessageLength: number;
  maxMessages: number;
}

export const RIDE_CHAT_LIMITS: RideChatLimits = {
  maxMessageLength: RIDE_CHAT_MAX_MESSAGE_LENGTH,
  maxMessages: RIDE_CHAT_MAX_MESSAGES_PER_RIDE,
};

export function toRideChatMessage(row: RideChatMessageRow): RideChatMessage {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userName: row.user_name,
    isOrganizer: row.is_organizer === true,
    text: row.message,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** 404 when the ride does not exist for the caller, 403 when it does but they are not on it. */
async function assertCanChat(rideId: string, userId: number): Promise<void> {
  const view = await getEventForViewer(rideId, userId);
  if (!canEvent(view.actor, "event:chat", view.context)) {
    throw new ApiError(403, "Only riders on this ride can use its chat (RIDE_CHAT_NO_ACCESS)");
  }
}

/** History (no afterId) or only newer messages (afterId). Oldest first. */
export async function listRideChat(
  rideId: string,
  userId: number,
  afterId: number | null,
): Promise<RideChatMessage[]> {
  await assertCanChat(rideId, userId);
  // The whole chat fits one page by construction (the per-ride cap), so history is one read.
  const rows = await selectRideChatMessages(rideId, afterId, RIDE_CHAT_MAX_MESSAGES_PER_RIDE);
  return rows.map(toRideChatMessage);
}

/** Validate and store one message. Returns it exactly as every reader will see it. */
export async function sendRideChat(
  rideId: string,
  userId: number,
  rawText: string,
): Promise<RideChatMessage> {
  const text = rawText.trim();
  if (!text) throw new ApiError(400, "Message is empty (RIDE_CHAT_EMPTY)");
  if (text.length > RIDE_CHAT_MAX_MESSAGE_LENGTH) {
    throw new ApiError(
      400,
      `Message is longer than ${RIDE_CHAT_MAX_MESSAGE_LENGTH} characters (RIDE_CHAT_TOO_LONG)`,
    );
  }
  await assertCanChat(rideId, userId);

  const result = await insertRideChatMessage(rideId, userId, text, RIDE_CHAT_MAX_MESSAGES_PER_RIDE);
  if (result.kind === "limit") {
    throw new ApiError(
      409,
      `This ride's chat is full (${RIDE_CHAT_MAX_MESSAGES_PER_RIDE} messages) (RIDE_CHAT_LIMIT)`,
    );
  }
  return toRideChatMessage(result.row);
}

export interface RideChatSummary {
  rideId: string;
  latestId: number | null;
  unread: number;
}

/**
 * Unread badges for a list of rides in one call. Rides the caller cannot chat in are left out
 * of the answer (the query applies the same rule as "event:chat").
 */
export async function summarizeRideChats(
  userId: number,
  rides: { rideId: string; lastReadId: number }[],
): Promise<RideChatSummary[]> {
  const rows = await selectUnreadSummary(
    userId,
    rides.slice(0, RIDE_CHAT_MAX_SUMMARY_RIDES),
    RIDE_CHAT_UNREAD_CAP,
  );
  return rows.map((row) => ({
    rideId: row.ride_id,
    latestId: row.latest_id == null ? null : Number(row.latest_id),
    unread: row.unread ?? 0,
  }));
}
