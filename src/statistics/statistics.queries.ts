// Rider Statistics — raw facts from the real tables, and the cache built from them.
//
// "COUNTS AS A RIDE" — Phase 1 product decision: event_participants (registered or approved,
// never left) joined to an events row that reached status='finished'. NO requirement that the
// rider's app ever sent a GPS point, and no requirement that anyone marked their individual
// result_status='finished'. Trusting participation is deliberate for now — deeper verification
// (GPS, duration, route matching) is an explicit future improvement, not a Phase 1 gap to close
// silently. See sql/035's header for the cache this feeds.

import { query, type Transaction } from "../db/pool.js";

export interface FinishedRideFacts {
  eventId: string;
  /** Calendar year the ride finished in — EXTRACT(YEAR FROM events.finished_at), never
   *  starts_at (which is when the ride was PLANNED, not when it happened). */
  year: number;
  /** COALESCE(participant_tracks.distance_km, attached route.distance_km, 0) — measured beats
   *  organizer-declared beats "unknown", never invented beyond that. */
  distanceKm: number;
  /** COALESCE(events.elevation_gain_m, attached route.elevation_m, 0) — there is no per-rider
   *  measured climb anywhere in the schema, so this is always the event's own value, credited
   *  to every finisher alike. An approximation by design, not a bug. */
  elevationM: number;
  /** Real elapsed time from participant_tracks (ended_at - started_at), in hours — null when
   *  the rider has no track. */
  durationHours: number | null;
  /** The organizer's stated ride time (events.duration_min), for a speed/hours estimate when
   *  there is no real GPS duration. */
  organizerDurationMin: number | null;
  /** The event's rider level, the last-resort speed guess when neither a real nor an
   *  organizer-stated duration exists. */
  level: string | null;
}

interface FinishedRideFactsRow {
  event_id: string;
  year: number;
  distance_km: string | number;
  elevation_m: string | number;
  duration_hours: string | number | null;
  organizer_duration_min: number | null;
  level: string | null;
}

/** One row per ride this user has "completed" per the rule above. */
export async function selectFinishedRideFactsForUser(userId: number): Promise<FinishedRideFacts[]> {
  const rows = await query<FinishedRideFactsRow>(
    `SELECT
        e.id AS event_id,
        EXTRACT(YEAR FROM e.finished_at)::int AS year,
        COALESCE(pt.distance_km, r.distance_km, 0) AS distance_km,
        COALESCE(e.elevation_gain_m, r.elevation_m, 0) AS elevation_m,
        CASE
          WHEN pt.started_at IS NOT NULL AND pt.ended_at IS NOT NULL AND pt.ended_at > pt.started_at
          THEN EXTRACT(EPOCH FROM (pt.ended_at - pt.started_at)) / 3600.0
          ELSE NULL
        END AS duration_hours,
        e.duration_min AS organizer_duration_min,
        e.level AS level
      FROM event_participants ep
      JOIN events e ON e.id = ep.event_id AND e.status = 'finished'
      LEFT JOIN participant_tracks pt ON pt.event_id = e.id AND pt.participant_id = ep.id
      LEFT JOIN LATERAL (
        SELECT r.distance_km, r.elevation_m
          FROM event_routes er
          JOIN routes r ON r.id = er.route_id
         WHERE er.event_id = e.id
         ORDER BY er.created_at DESC
         LIMIT 1
      ) r ON TRUE
     WHERE ep.user_id = $1
       AND ep.registration_status IN ('registered', 'approved')
       AND ep.left_at IS NULL
       AND e.finished_at IS NOT NULL`,
    [userId],
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    year: row.year,
    distanceKm: Number(row.distance_km),
    elevationM: Number(row.elevation_m),
    durationHours: row.duration_hours == null ? null : Number(row.duration_hours),
    organizerDurationMin: row.organizer_duration_min,
    level: row.level,
  }));
}

/**
 * Every rider actually on the start list for one event, with an account to credit — used only
 * by the finish hook (statistics.service.ts's refreshStatsForFinishedEvent) to know whose cache
 * to eagerly recompute. Same registration filter as selectFinishedRideFactsForUser, read the
 * other direction (one event -> its riders, instead of one rider -> their events).
 */
export async function selectFinishedEventParticipantUserIds(eventId: string): Promise<number[]> {
  const rows = await query<{ user_id: number }>(
    `SELECT user_id FROM event_participants
      WHERE event_id = $1 AND user_id IS NOT NULL
        AND registration_status IN ('registered', 'approved')
        AND left_at IS NULL`,
    [eventId],
  );
  return rows.map((row) => row.user_id);
}

export interface RiderStatsTotals {
  ridesCount: number;
  totalKm: number;
  totalClimbM: number;
  totalHours: number;
  /** null when the rider has no weight_kg set — never a number built on a guessed weight. */
  totalCalories: number | null;
}

interface StatsCacheRow {
  user_id: number;
  year: number;
  country: string | null;
  rides_count: number;
  total_km: string | number;
  total_climb_m: string | number;
  total_hours: string | number;
  total_calories: number | null;
  computed_at: Date;
}

export interface CachedRiderStats extends RiderStatsTotals {
  computedAt: Date;
}

/** `year = 0` is the lifetime row — see sql/035's header for why 0, not NULL. */
export const LIFETIME_YEAR = 0;

export async function selectStatsCache(
  userId: number,
  year: number,
): Promise<CachedRiderStats | null> {
  const rows = await query<StatsCacheRow>(
    `SELECT user_id, year, country, rides_count, total_km, total_climb_m, total_hours,
            total_calories, computed_at
       FROM rider_stats_cache
      WHERE user_id = $1 AND year = $2`,
    [userId, year],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ridesCount: row.rides_count,
    totalKm: Number(row.total_km),
    totalClimbM: Number(row.total_climb_m),
    totalHours: Number(row.total_hours),
    totalCalories: row.total_calories,
    computedAt: row.computed_at,
  };
}

/**
 * Overwrites this rider's cache row for one scope — including a fresh snapshot of their
 * current users.country, so the leaderboard's denormalized country (sql/035's header) never
 * drifts more than one recompute behind the real value. Called after recomputing from the raw
 * tables — never called with a value nobody just derived from them.
 */
export async function upsertStatsCache(
  userId: number,
  year: number,
  country: string | null,
  totals: RiderStatsTotals,
  tx?: Transaction,
): Promise<void> {
  const runner = tx ?? { query };
  await runner.query(
    `INSERT INTO rider_stats_cache
        (user_id, year, country, rides_count, total_km, total_climb_m, total_hours,
         total_calories, computed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (user_id, year) DO UPDATE
         SET country        = EXCLUDED.country,
             rides_count    = EXCLUDED.rides_count,
             total_km       = EXCLUDED.total_km,
             total_climb_m  = EXCLUDED.total_climb_m,
             total_hours    = EXCLUDED.total_hours,
             total_calories = EXCLUDED.total_calories,
             computed_at    = NOW()`,
    [
      userId,
      year,
      country,
      totals.ridesCount,
      totals.totalKm,
      totals.totalClimbM,
      totals.totalHours,
      totals.totalCalories,
    ],
  );
}

/** Exactly the four National Leaderboard categories, in this order — no Calories (asked for
 *  directly: calories stay on the rider's own personal Statistics screen). */
export type LeaderboardCategory = "rides" | "distanceKm" | "climbM" | "hours";

const LEADERBOARD_COLUMN: Record<LeaderboardCategory, string> = {
  rides: "rides_count",
  distanceKm: "total_km",
  climbM: "total_climb_m",
  hours: "total_hours",
};

export interface LeaderboardRow {
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarType: string | null;
  avatarValue: string | null;
  value: number;
  rank: number;
}

/**
 * Top `limit` riders by `category`, for `year` (LIFETIME_YEAR for all-time) AND `country`, plus
 * — in the SAME query, so ranking is computed exactly once and can never disagree with itself —
 * the caller's own row even when it falls outside that limit. Reads rider_stats_cache directly
 * (this is the query the cache exists for): ranking every rider fresh from the raw tables on
 * every leaderboard view is exactly the repeated-aggregation cost the cache avoids.
 *
 * A rider who has never opened Statistics, or who has no country set, has no ranked row at all
 * — not a wrong rank, just not yet computed / not yet scoped to a country. See
 * statistics.service.ts's ensureCallerFresh for the one guarantee this table does give: the
 * CALLER's own row is always fresh by the time this runs, because the service refreshes it
 * first (only when the caller has a country to rank in).
 */
export async function selectLeaderboard(
  category: LeaderboardCategory,
  year: number,
  country: string,
  callerUserId: number,
  limit = 50,
): Promise<{ top: LeaderboardRow[]; me: LeaderboardRow | null }> {
  const column = LEADERBOARD_COLUMN[category];
  const rows = await query<{
    user_id: number;
    first_name: string | null;
    last_name: string | null;
    nickname: string | null;
    avatar_url: string | null;
    avatar_type: string | null;
    avatar_value: string | null;
    value: string | number | null;
    rank: string;
  }>(
    `WITH ranked AS (
        SELECT
          rsc.user_id,
          rsc.${column} AS value,
          RANK() OVER (ORDER BY rsc.${column} DESC NULLS LAST) AS rank
        FROM rider_stats_cache rsc
       WHERE rsc.year = $1 AND rsc.country = $2 AND rsc.${column} IS NOT NULL
     )
     SELECT
        ranked.user_id,
        u.first_name, u.last_name, u.nickname,
        u.avatar_url, u.avatar_type, u.avatar_value,
        ranked.value,
        ranked.rank
      FROM ranked
      JOIN users u ON u.id = ranked.user_id
     WHERE ranked.rank <= $3 OR ranked.user_id = $4
     ORDER BY ranked.rank ASC`,
    [year, country, limit, callerUserId],
  );

  const toRow = (row: (typeof rows)[number]): LeaderboardRow => ({
    userId: row.user_id,
    displayName:
      [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.nickname || "A rider",
    avatarUrl: row.avatar_url,
    avatarType: row.avatar_type,
    avatarValue: row.avatar_value,
    value: Number(row.value ?? 0),
    rank: Number(row.rank),
  });

  const all = rows.map(toRow);
  return {
    top: all.filter((row) => row.rank <= limit),
    me: all.find((row) => row.userId === callerUserId) ?? null,
  };
}
