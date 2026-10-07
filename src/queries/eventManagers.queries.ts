// Ride MANAGERS — the people a ride's creator lets run the ride with them.
//
// A manager with an account is an event_members row with role = 'operator' (sql/002). An email
// nobody has signed in with yet waits in event_manager_invites (sql/059) until its first Google
// sign-in. See eventManagers.service.ts for the rules; this file is only the SQL.

import { execute, query, queryOne, withTransaction } from "../db/pool.js";

/** The caller's role row on a ride, or null — the cheap half of "is this person an organizer". */
export async function selectEventMemberRole(
  eventId: string,
  userId: number,
): Promise<"owner" | "operator" | "viewer" | null> {
  const row = await queryOne<{ role: "owner" | "operator" | "viewer" }>(
    "SELECT role FROM event_members WHERE event_id = $1 AND user_id = $2",
    [eventId, userId],
  );
  return row?.role ?? null;
}

export interface ManagerRow {
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  email: string | null;
  joined_at: Date;
}

/** Every operator on the ride, with a name and one email to show next to it. */
export async function selectEventManagers(eventId: string): Promise<ManagerRow[]> {
  return query<ManagerRow>(
    `SELECT em.user_id, u.first_name, u.last_name, u.nickname, em.joined_at,
            (SELECT ai.email FROM auth_identities ai
              WHERE ai.user_id = em.user_id AND ai.email IS NOT NULL
              ORDER BY (ai.provider = 'GOOGLE') DESC, ai.id
              LIMIT 1) AS email
       FROM event_members em
       JOIN users u ON u.id = em.user_id
      WHERE em.event_id = $1 AND em.role = 'operator'
      ORDER BY em.joined_at, em.user_id`,
    [eventId],
  );
}

/** The account an email belongs to, Google first (its email is verified). */
export async function selectUserIdByEmail(email: string): Promise<number | null> {
  const row = await queryOne<{ user_id: number }>(
    `SELECT user_id FROM auth_identities
      WHERE lower(email) = $1
      ORDER BY (provider = 'GOOGLE') DESC, id
      LIMIT 1`,
    [email],
  );
  return row?.user_id ?? null;
}

/**
 * Makes `userId` an operator on the ride. Never touches an existing row: an owner stays the
 * owner, and a repeated add is a no-op. Returns whether a row was written.
 */
export async function insertEventManager(eventId: string, userId: number): Promise<boolean> {
  const written = await execute(
    `INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, 'operator')
      ON CONFLICT (event_id, user_id) DO NOTHING`,
    [eventId, userId],
  );
  return written > 0;
}

/** Removes an operator. The owner row is never matched. */
export async function deleteEventManager(eventId: string, userId: number): Promise<boolean> {
  const removed = await execute(
    "DELETE FROM event_members WHERE event_id = $1 AND user_id = $2 AND role = 'operator'",
    [eventId, userId],
  );
  return removed > 0;
}

export interface ManagerInviteRow {
  email: string;
  created_at: Date;
}

export async function selectManagerInvites(eventId: string): Promise<ManagerInviteRow[]> {
  return query<ManagerInviteRow>(
    `SELECT email, created_at FROM event_manager_invites
      WHERE event_id = $1 ORDER BY created_at, id`,
    [eventId],
  );
}

export async function insertManagerInvite(
  eventId: string,
  email: string,
  invitedBy: number,
): Promise<void> {
  await execute(
    `INSERT INTO event_manager_invites (event_id, email, invited_by) VALUES ($1, $2, $3)
      ON CONFLICT (event_id, email) DO NOTHING`,
    [eventId, email, invitedBy],
  );
}

export async function deleteManagerInvite(eventId: string, email: string): Promise<boolean> {
  const removed = await execute(
    "DELETE FROM event_manager_invites WHERE event_id = $1 AND email = $2",
    [eventId, email],
  );
  return removed > 0;
}

/**
 * Turns every waiting invite for `email` into an operator row for `userId`, in one transaction,
 * and returns the ride ids it claimed. A ride where the user already has a row (they are its
 * owner, say) keeps that row; the invite is still consumed.
 */
export async function claimManagerInvitesForEmail(
  userId: number,
  email: string,
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const invites = await tx.query<{ event_id: string }>(
      "DELETE FROM event_manager_invites WHERE email = $1 RETURNING event_id",
      [email],
    );
    for (const { event_id } of invites) {
      await tx.query(
        `INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, 'operator')
          ON CONFLICT (event_id, user_id) DO NOTHING`,
        [event_id, userId],
      );
    }
    return invites.map((invite) => invite.event_id);
  });
}
