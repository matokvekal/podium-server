// SQL for TRACK LIKES AND FAVOURITES — the `route_likes` and `route_favorites` tables (sql/036).
//
// Two tables, two different rules, and the difference is the whole point of this file:
//
//   route_likes      PUBLIC, PERMANENT, COUNTED.  Insert only. A rider likes a track once and
//                    the number it feeds can only ever go up — the same append-only rule
//                    route_copies follows, for the same reason (sql/018's "counts are read from
//                    the rows, never stored, so they cannot drift").
//
//   route_favorites  PRIVATE, REVERSIBLE, UNCOUNTED. The rider's own bookmark list. Removing a
//                    bookmark must actually remove it, so DELETE is legal here — and ONLY here.
//
// THE ONE RULE THAT SHAPES THIS FILE: there is no UPDATE and no DELETE against `route_likes`,
// and none should be added. routeLike.queries.test.ts fails if one appears. If a product
// decision ever introduces "unlike", it needs a new file and a new conversation about what
// happens to the count — not an edit here.
//
// Double-counting is prevented by the database, not by callers: both tables are UNIQUE on
// (route_id, user_id) and every insert is ON CONFLICT DO NOTHING. A double-tap, a retry or an
// offline replay still counts once.

import { query, queryOne } from "../db/pool.js";

/**
 * Records one like. Returns true when a row was actually written, false when this rider had
 * already liked this track (the ON CONFLICT case).
 *
 * The caller uses the difference only to decide what to log — the response is the same either
 * way, because "you have liked this" is the true answer in both cases. That is what makes the
 * endpoint idempotent, which matters: the button is on a card in an infinite-scrolling list,
 * and a rider on a bad connection will press it twice.
 */
export async function insertRouteLike(routeId: number, userId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO route_likes (route_id, user_id)
          VALUES ($1, $2)
     ON CONFLICT (route_id, user_id) DO NOTHING
       RETURNING id`,
    [routeId, userId],
  );
  return row !== null;
}

/**
 * How many riders have liked this track — the number the gallery card shows next to the heart.
 *
 * Counted from the rows themselves rather than read off a stored counter, the same rule
 * sql/018-user-limits.sql sets for usage: a count derived from rows can never drift.
 */
export async function selectRouteLikeCount(routeId: number): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    "SELECT COUNT(*) AS count FROM route_likes WHERE route_id = $1",
    [routeId],
  );
  return Number(row?.count ?? 0);
}

/** Whether this rider has already liked this track — drives the button's pressed state. */
export async function selectRouteLikedByUser(routeId: number, userId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM route_likes WHERE route_id = $1 AND user_id = $2",
    [routeId, userId],
  );
  return row !== null;
}

/**
 * The batched form, for a list that needs a count per row without N queries. Returns a Map so a
 * track with no likes is simply absent — callers should read it as `counts.get(id) ?? 0`.
 *
 * Not used by the public list, which gets the count from its own LEFT JOIN LATERAL in one round
 * trip (event.queries.ts). This is here for any surface that already holds the route ids.
 */
export async function selectRouteLikeCounts(routeIds: number[]): Promise<Map<number, number>> {
  if (routeIds.length === 0) return new Map();
  const rows = await query<{ route_id: number; count: string | number }>(
    `SELECT route_id, COUNT(*) AS count
       FROM route_likes
      WHERE route_id = ANY($1::bigint[])
      GROUP BY route_id`,
    [routeIds],
  );
  return new Map(rows.map((r) => [Number(r.route_id), Number(r.count)]));
}

/**
 * Adds this track to the rider's own list. Returns true when a row was written, false when it
 * was already there — same idempotence as the like, for the same reason.
 */
export async function insertRouteFavorite(routeId: number, userId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO route_favorites (route_id, user_id)
          VALUES ($1, $2)
     ON CONFLICT (route_id, user_id) DO NOTHING
       RETURNING id`,
    [routeId, userId],
  );
  return row !== null;
}

/**
 * Removes this track from the rider's own list. Returns true when a row went away.
 *
 * THE ONLY DELETE IN THIS FILE, and it must stay that way — see the header. It is legal because
 * a favourite is a private bookmark that nobody counts, not a public tally.
 */
export async function deleteRouteFavorite(routeId: number, userId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    "DELETE FROM route_favorites WHERE route_id = $1 AND user_id = $2 RETURNING id",
    [routeId, userId],
  );
  return row !== null;
}

/** Whether this track is in the rider's own list — drives the heart's filled state. */
export async function selectRouteFavoritedByUser(
  routeId: number,
  userId: number,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM route_favorites WHERE route_id = $1 AND user_id = $2",
    [routeId, userId],
  );
  return row !== null;
}
