// Queries for the RIDE CHAT (sql/047-ride-chat.sql). Every read is by ride_id over the one
// (ride_id, id) index; nothing here loads a chat it was not asked for.
//
// Authorization is NOT decided here — the service asks src/authz/policy.ts ("event:chat") before
// calling any of these. The one exception is selectUnreadSummary, which answers for many rides
// in one statement and so applies the same rule in SQL (see its own comment).

import { query, withTransaction } from "../db/pool.js";

export interface RideChatMessageRow {
  id: string; // BIGINT arrives as a string from pg
  user_id: string;
  user_name: string | null;
  message: string;
  created_at: Date;
  is_organizer: boolean;
}

/**
 * The sender's name as the app shows it everywhere else: first + last, else nickname — the
 * same COALESCE as owner_name in event.queries.ts. Taken once, at send time, into the snapshot.
 */
const SENDER_NAME = `(SELECT COALESCE(
                        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                        u.nickname
                      ) FROM users u WHERE u.id = $2)`;

/** Organizer badge: the ride's owner, or a co-organizer (event_members owner / operator). */
const IS_ORGANIZER = `(m.user_id = e.owner_id OR EXISTS (
        SELECT 1 FROM event_members em
         WHERE em.event_id = m.ride_id AND em.user_id = m.user_id
           AND em.role IN ('owner', 'operator')))`;

/**
 * A ride's messages in order, oldest first. With `afterId`, only newer ones — the polling read,
 * so an open chat never downloads its whole history twice.
 */
export async function selectRideChatMessages(
  rideId: string,
  afterId: number | null,
  limit: number,
): Promise<RideChatMessageRow[]> {
  return query<RideChatMessageRow>(
    `SELECT m.id, m.user_id, m.user_name_snapshot AS user_name, m.message, m.created_at,
            ${IS_ORGANIZER} AS is_organizer
       FROM ride_chat_messages m
       JOIN events e ON e.id = m.ride_id
      WHERE m.ride_id = $1
        AND ($2::bigint IS NULL OR m.id > $2::bigint)
      ORDER BY m.id
      LIMIT $3`,
    [rideId, afterId, limit],
  );
}

export type InsertRideChatResult = { kind: "ok"; row: RideChatMessageRow } | { kind: "limit" };

/**
 * Store one message, unless the ride's chat is already full.
 *
 * The count and the insert run under a per-ride advisory lock in one transaction, so two
 * riders sending the 500th message at the same moment cannot both get in. The lock is
 * transaction-scoped and per ride — other rides' chats never wait on it.
 *
 * Identity, name and time come from the server: user_id is the caller's, the name is read from
 * `users` here, and created_at is the database's NOW().
 */
export async function insertRideChatMessage(
  rideId: string,
  userId: number,
  message: string,
  maxMessages: number,
): Promise<InsertRideChatResult> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ride_chat:' || $1))", [rideId]);
    const count = await tx.queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM ride_chat_messages WHERE ride_id = $1",
      [rideId],
    );
    if ((count?.count ?? 0) >= maxMessages) return { kind: "limit" };

    const row = await tx.queryOne<RideChatMessageRow>(
      `WITH m AS (
         INSERT INTO ride_chat_messages (ride_id, user_id, user_name_snapshot, message)
         VALUES ($1, $2, LEFT(${SENDER_NAME}, 120), $3)
         RETURNING *
       )
       SELECT m.id, m.user_id, m.user_name_snapshot AS user_name, m.message, m.created_at,
              ${IS_ORGANIZER} AS is_organizer
         FROM m JOIN events e ON e.id = m.ride_id`,
      [rideId, userId, message],
    );
    if (!row) throw new Error("ride chat insert returned no row");
    return { kind: "ok", row };
  });
}

export interface RideChatSummaryRow {
  ride_id: string;
  latest_id: string | null;
  unread: number;
}

/**
 * Unread counts for many rides in ONE statement — the ride list's badge refresh, so a list of
 * cards never makes one request per card. The client says, per ride, the last message id it
 * has read (kept in its own storage); this answers how many are newer and the newest id.
 *
 * AUTHORIZATION IN SQL, deliberately the same rule as policy.ts "event:chat": the ride's owner,
 * an event_members owner / operator, or a participant whose status is registered / approved
 * (buildEventContext's "approved"). A ride the caller has no access to is simply absent from
 * the answer — never an error, so this cannot be used to probe which ride ids exist.
 *
 * The unread count is capped (LIMIT inside the lateral) so a big chat costs a bounded read.
 */
export async function selectUnreadSummary(
  userId: number,
  rides: { rideId: string; lastReadId: number }[],
  cap: number,
): Promise<RideChatSummaryRow[]> {
  if (rides.length === 0) return [];
  return query<RideChatSummaryRow>(
    `SELECT r.ride_id::text AS ride_id, latest.latest_id, unread.unread
       FROM unnest($2::uuid[], $3::bigint[]) AS r(ride_id, last_read)
       JOIN events e ON e.id = r.ride_id
       LEFT JOIN LATERAL (
         SELECT MAX(m.id)::text AS latest_id FROM ride_chat_messages m WHERE m.ride_id = r.ride_id
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread FROM (
           SELECT 1 FROM ride_chat_messages m
            WHERE m.ride_id = r.ride_id AND m.id > r.last_read AND m.user_id <> $1
            LIMIT $4
         ) newer
       ) unread ON TRUE
      WHERE e.owner_id = $1
         OR EXISTS (SELECT 1 FROM event_members em
                     WHERE em.event_id = e.id AND em.user_id = $1
                       AND em.role IN ('owner', 'operator'))
         OR EXISTS (SELECT 1 FROM event_participants ep
                     WHERE ep.event_id = e.id AND ep.user_id = $1
                       AND ep.registration_status IN ('registered', 'approved'))`,
    [userId, rides.map((r) => r.rideId), rides.map((r) => r.lastReadId), cap],
  );
}
