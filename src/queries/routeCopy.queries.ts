// SQL for THE TRACK COPY LEDGER — the append-only `route_copies` table (sql/025).
//
// One row per (track, ride that was built on it). It answers two questions:
//
//   "how many rides have been built on this track"  -> selectRouteCopyCount
//   "who has used my track" / "what have I copied"  -> the indexes, for a surface not built yet
//
// THE ONE RULE THAT SHAPES EVERY QUERY HERE: this table is APPEND-ONLY. There is no update and
// no delete in this file, and none should be added. The count it feeds must never go down —
// that is the entire reason the table exists rather than a COUNT(*) over `event_routes`, which
// would drop the moment a copier detached the track or their ride went away. See the WHY block
// at the top of sql/025-track-copy-lineage.sql.
//
// Double-counting is prevented by the database, not by callers: `route_copies_route_event_key`
// is UNIQUE on (route_id, new_event_id) and every insert here is ON CONFLICT DO NOTHING. A ride
// that re-saves ten times still counts once.

import { query, queryOne } from "../db/pool.js";

export interface RouteCopyInput {
  /** routes.id — the track that got used. */
  routeId: number;
  /** users.id — the rider who built a ride on it. */
  copiedByUserId: number;
  /** events.id — the ride they built. */
  newEventId: string;
  /** events.id they copied from, or null when the track came straight out of Find Tracks. */
  sourceEventId: string | null;
}

/**
 * Records one copy. Returns true when a row was actually written, false when this ride was
 * already counted against this track (the ON CONFLICT case) — the caller logs the difference,
 * nothing depends on it.
 *
 * Callers must treat a THROW from here as non-fatal: the attach that preceded it has already
 * committed, and a ride must never be lost over a counter. See recordRouteCopy in
 * services/eventRoute.service.ts, which is the only intended caller.
 */
export async function insertRouteCopy(input: RouteCopyInput): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO route_copies (route_id, copied_by_user_id, new_event_id, source_event_id)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (route_id, new_event_id) DO NOTHING
       RETURNING id`,
    [input.routeId, input.copiedByUserId, input.newEventId, input.sourceEventId],
  );
  return row !== null;
}

/**
 * How many rides have been built on this track — the number the gallery card shows as
 * "Downloads" (client: useTrackGallery.ts's `usedByRides`).
 *
 * Counted from the rows themselves rather than read off a stored counter, the same rule
 * sql/018-user-limits.sql sets for usage: a count derived from rows can never drift.
 */
export async function selectRouteCopyCount(routeId: number): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    "SELECT COUNT(*) AS count FROM route_copies WHERE route_id = $1",
    [routeId],
  );
  return Number(row?.count ?? 0);
}

/**
 * The batched form, for a list that needs a count per row without N queries. Returns a Map so a
 * track with no copies is simply absent — callers should read it as `counts.get(id) ?? 0`.
 *
 * Not used yet: the gallery asks one route at a time as its cards scroll into view. It is here
 * because the moment any list wants this number, doing it per row is the wrong answer.
 */
export async function selectRouteCopyCounts(routeIds: number[]): Promise<Map<number, number>> {
  if (routeIds.length === 0) return new Map();
  const rows = await query<{ route_id: number; count: string | number }>(
    `SELECT route_id, COUNT(*) AS count
       FROM route_copies
      WHERE route_id = ANY($1::bigint[])
      GROUP BY route_id`,
    [routeIds],
  );
  return new Map(rows.map((r) => [Number(r.route_id), Number(r.count)]));
}
