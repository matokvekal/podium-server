// Queries for RIDE STOP POINTS (sql/049-ride-stop-points.sql). Every read and write is by
// ride_id over the one (ride_id, sort_order, id) index.
//
// Authorization is NOT decided here — the service asks src/authz/policy.ts first. Every write
// still carries the ride id in its WHERE, so a stop id from another ride matches nothing.

import { query, queryOne, withTransaction } from "../db/pool.js";

export interface RideStopRow {
  id: string; // BIGINT arrives as a string from pg
  ride_id: string;
  label: string;
  lat: number;
  lng: number;
  kind: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "id, ride_id, label, lat, lng, kind, sort_order, created_at, updated_at";

/** A ride's stops in the creator's order (then oldest first). */
export async function selectRideStops(rideId: string): Promise<RideStopRow[]> {
  return query<RideStopRow>(
    `SELECT ${COLUMNS} FROM ride_stop_points WHERE ride_id = $1 ORDER BY sort_order, id`,
    [rideId],
  );
}

export type InsertRideStopResult = { kind: "ok"; row: RideStopRow } | { kind: "limit" };

/**
 * Add one stop, unless the ride already has `maxStops`. Count and insert run under a per-ride
 * advisory lock in one transaction (same as the chat's message cap), so two quick taps cannot
 * both slip in as the 5th. The new stop goes to the end of the list.
 */
export async function insertRideStop(
  rideId: string,
  userId: number,
  input: { label: string; lat: number; lng: number; kind: string },
  maxStops: number,
): Promise<InsertRideStopResult> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ride_stops:' || $1))", [rideId]);
    const stats = await tx.queryOne<{ count: number; next_order: number }>(
      `SELECT COUNT(*)::int AS count, COALESCE(MAX(sort_order) + 1, 0)::int AS next_order
         FROM ride_stop_points WHERE ride_id = $1`,
      [rideId],
    );
    if ((stats?.count ?? 0) >= maxStops) return { kind: "limit" };

    const row = await tx.queryOne<RideStopRow>(
      `INSERT INTO ride_stop_points (ride_id, label, lat, lng, kind, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [rideId, input.label, input.lat, input.lng, input.kind, stats?.next_order ?? 0, userId],
    );
    if (!row) throw new Error("ride stop insert returned no row");
    return { kind: "ok", row };
  });
}

/**
 * Change the given fields of one stop. Only keys present in `patch` are written. Returns null
 * when the stop does not exist on THIS ride.
 */
export async function updateRideStop(
  rideId: string,
  stopId: number,
  patch: { label?: string; lat?: number; lng?: number; kind?: string; sortOrder?: number },
): Promise<RideStopRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [rideId, stopId];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.label !== undefined) add("label", patch.label);
  if (patch.lat !== undefined) add("lat", patch.lat);
  if (patch.lng !== undefined) add("lng", patch.lng);
  if (patch.kind !== undefined) add("kind", patch.kind);
  if (patch.sortOrder !== undefined) add("sort_order", patch.sortOrder);
  sets.push("updated_at = NOW()");

  return queryOne<RideStopRow>(
    `UPDATE ride_stop_points SET ${sets.join(", ")}
      WHERE ride_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    params,
  );
}

/** True when a stop on THIS ride was deleted. */
export async function deleteRideStop(rideId: string, stopId: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "DELETE FROM ride_stop_points WHERE ride_id = $1 AND id = $2 RETURNING id",
    [rideId, stopId],
  );
  return rows.length > 0;
}
