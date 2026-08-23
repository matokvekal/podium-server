// SQL for event_groups and the group_id column on event_participants.

import { execute, query, queryOne } from "../db/pool.js";
import type { EventGroup } from "../db/types.js";

interface EventGroupRow {
  id: number;
  event_id: string;
  name: string;
  starts_at: Date | null;
  route_id: number | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

function mapGroup(row: EventGroupRow): EventGroup {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    startsAt: row.starts_at,
    routeId: row.route_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function selectGroupsForEvent(eventId: string): Promise<EventGroup[]> {
  const rows = await query<EventGroupRow>(
    "SELECT * FROM event_groups WHERE event_id = $1 ORDER BY sort_order ASC, id ASC",
    [eventId],
  );
  return rows.map(mapGroup);
}

export async function selectGroupById(
  groupId: number,
  eventId: string,
): Promise<EventGroup | null> {
  const row = await queryOne<EventGroupRow>(
    "SELECT * FROM event_groups WHERE id = $1 AND event_id = $2",
    [groupId, eventId],
  );
  return row ? mapGroup(row) : null;
}

export async function countGroupsForEvent(eventId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM event_groups WHERE event_id = $1",
    [eventId],
  );
  return Number(row?.count ?? 0);
}

export async function insertGroup(input: {
  eventId: string;
  name: string;
  startsAt: Date | null;
  routeId: number | null;
  sortOrder: number;
}): Promise<EventGroup> {
  const row = await queryOne<EventGroupRow>(
    `INSERT INTO event_groups (event_id, name, starts_at, route_id, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
    [input.eventId, input.name, input.startsAt, input.routeId, input.sortOrder],
  );
  if (!row) throw new Error("insertGroup returned no row");
  return mapGroup(row);
}

/**
 * Partial update. `startsAt` and `routeId` are the two fields that must be *clearable* —
 * "this group starts with everyone else" and "this group uses the event's track" are real
 * answers — so they take an explicit `null` rather than being COALESCEd away. The `$n IS
 * NULL` guards distinguish "not mentioned" from "set to null".
 */
export async function updateGroup(
  groupId: number,
  eventId: string,
  input: {
    name?: string;
    startsAt?: Date | null;
    routeId?: number | null;
    sortOrder?: number;
    clearStartsAt?: boolean;
    clearRouteId?: boolean;
  },
): Promise<EventGroup | null> {
  const rows = await query<EventGroupRow>(
    `UPDATE event_groups
        SET name = COALESCE($3, name),
            starts_at = CASE WHEN $4 THEN NULL ELSE COALESCE($5, starts_at) END,
            route_id = CASE WHEN $6 THEN NULL ELSE COALESCE($7, route_id) END,
            sort_order = COALESCE($8, sort_order),
            updated_at = NOW()
      WHERE id = $1 AND event_id = $2
      RETURNING *`,
    [
      groupId,
      eventId,
      input.name ?? null,
      input.clearStartsAt ?? false,
      input.startsAt ?? null,
      input.clearRouteId ?? false,
      input.routeId ?? null,
      input.sortOrder ?? null,
    ],
  );
  return rows[0] ? mapGroup(rows[0]) : null;
}

/**
 * Deleting a group un-assigns its riders rather than removing them: they are still in the
 * event, they just are not in a group any more. Losing a rider from the start list because
 * the organizer tidied up their groups would be a data-loss bug.
 */
export async function deleteGroup(groupId: number, eventId: string): Promise<boolean> {
  await execute("UPDATE event_participants SET group_id = NULL WHERE group_id = $1", [groupId]);
  return (await execute("DELETE FROM event_groups WHERE id = $1 AND event_id = $2", [
    groupId,
    eventId,
  ])) > 0;
}

/**
 * Assigns several riders at once — the common case in practice. The client has had a
 * `setGroupIdBulk` since before any of this existed, because filling a 20-person group one
 * rider at a time is the actual complaint.
 */
export async function assignParticipantsToGroup(
  eventId: string,
  participantIds: number[],
  groupId: number | null,
): Promise<number> {
  return execute(
    `UPDATE event_participants
        SET group_id = $3
      WHERE event_id = $1 AND id = ANY($2::bigint[])`,
    [eventId, participantIds, groupId],
  );
}

/** Every group id currently in use on this event, to validate an assignment against. */
export async function selectGroupIdsForEvent(eventId: string): Promise<number[]> {
  const rows = await query<{ id: number }>("SELECT id FROM event_groups WHERE event_id = $1", [
    eventId,
  ]);
  return rows.map((r) => r.id);
}
