// Every SQL statement the /admin2026 dashboard needs. Mostly read-only aggregates over the real
// business tables (users, events, event_participants) — the spec's rule: historical totals come
// from the business timestamps, not from analytics_events (which only started collecting
// later). The one deliberate exception is site traffic (dailyTraffic/topPages below): there is
// no business-table equivalent for a page view, so those two read analytics_events directly.
//
// `events.country` / `users.country` arrive with sql/030. If that migration has not run on this
// database yet, the country queries here return empty rather than 500 — same
// isMissingColumnError degrade the event/route writers use.

import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import type { CountryRow, DailyRow, TopPageRow, TrafficDailyRow } from "./adminAnalytics.types.js";

function errCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
}
/** column missing (pre-sql/030 country columns). */
function isMissingColumn(err: unknown): boolean {
  return errCode(err) === "42703";
}
/** table missing (pre-sql/025 route_copies). */
function isMissingTable(err: unknown): boolean {
  return errCode(err) === "42P01";
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await query<{ n: number | string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export function countUsers(): Promise<number> {
  return scalar("SELECT COUNT(*)::int AS n FROM users");
}

export function countRideCreators(): Promise<number> {
  return scalar("SELECT COUNT(DISTINCT owner_id)::int AS n FROM events WHERE owner_id IS NOT NULL");
}

export function countRides(): Promise<number> {
  return scalar("SELECT COUNT(*)::int AS n FROM events");
}

/** On a start list right now — the same rule the ride card's participant count uses. */
export function countCurrentRegistrations(): Promise<number> {
  return scalar(
    `SELECT COUNT(*)::int AS n
       FROM event_participants
      WHERE registration_status IN ('registered', 'approved', 'waiting_approval')
        AND left_at IS NULL`,
  );
}

/** Every participant row ever — the all-time joins figure. */
export function countHistoricalJoins(): Promise<number> {
  return scalar("SELECT COUNT(*)::int AS n FROM event_participants");
}

export async function countActiveCountries(): Promise<number> {
  try {
    return await scalar(
      "SELECT COUNT(DISTINCT country)::int AS n FROM events WHERE country IS NOT NULL",
    );
  } catch (err) {
    if (isMissingColumn(err)) {
      logger.warn({}, "admin-analytics: events.country missing — run sql/030-country.sql");
      return 0;
    }
    throw err;
  }
}

/**
 * Route creation + reuse, all time.
 *   created / fromGpx  — the `routes` table (routes.source, db/types.ts ROUTE_SOURCES).
 *   copies / copiers   — the append-only `route_copies` ledger (sql/025). 0 if not applied.
 */
export async function routeStats(): Promise<{
  created: number;
  fromGpx: number;
  copies: number;
  distinctCopiers: number;
}> {
  const routeRows = await query<{ created: number | string; from_gpx: number | string }>(
    `SELECT COUNT(*)::int AS created,
            COUNT(*) FILTER (WHERE source = 'gpx')::int AS from_gpx
       FROM routes`,
  );
  const created = Number(routeRows[0]?.created ?? 0);
  const fromGpx = Number(routeRows[0]?.from_gpx ?? 0);

  let copies = 0;
  let distinctCopiers = 0;
  try {
    const copyRows = await query<{ copies: number | string; copiers: number | string }>(
      `SELECT COUNT(*)::int AS copies,
              COUNT(DISTINCT copied_by_user_id)::int AS copiers
         FROM route_copies`,
    );
    copies = Number(copyRows[0]?.copies ?? 0);
    distinctCopiers = Number(copyRows[0]?.copiers ?? 0);
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn({}, "admin-analytics: route_copies missing — run sql/025-track-copy-lineage.sql");
    } else {
      throw err;
    }
  }

  return { created, fromGpx, copies, distinctCopiers };
}

export async function ridesByVisibility(): Promise<Record<string, number>> {
  const rows = await query<{ visibility: string; n: number | string }>(
    "SELECT visibility, COUNT(*)::int AS n FROM events GROUP BY visibility",
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.visibility] = Number(r.n);
  return out;
}

/**
 * One row per day that had ANY of: a new user, a new ride, a new participant — over the last
 * `sinceDays` days (null = all time). NEWEST FIRST. Real business timestamps only.
 */
export async function dailyActivity(sinceDays: number | null): Promise<DailyRow[]> {
  const rows = await query<{
    date: string;
    new_users: number | string;
    new_rides: number | string;
    new_participants: number | string;
  }>(
    `WITH activity AS (
        SELECT created_at::date AS day, 'user'::text AS kind FROM users
        UNION ALL
        SELECT created_at::date, 'ride' FROM events
        UNION ALL
        SELECT joined_at::date, 'join' FROM event_participants
     )
     SELECT to_char(day, 'YYYY-MM-DD') AS date,
            COUNT(*) FILTER (WHERE kind = 'user') AS new_users,
            COUNT(*) FILTER (WHERE kind = 'ride') AS new_rides,
            COUNT(*) FILTER (WHERE kind = 'join') AS new_participants
       FROM activity
      WHERE $1::int IS NULL OR day >= (CURRENT_DATE - ($1::int - 1))
      GROUP BY day
      ORDER BY day DESC
      LIMIT 400`,
    [sinceDays],
  );
  return rows.map((r) => ({
    date: r.date,
    newUsers: Number(r.new_users),
    newRides: Number(r.new_rides),
    newParticipants: Number(r.new_participants),
  }));
}

/**
 * Users and rides per country, most rides first. users.country is NULL for most riders (their
 * client fills it from locale on login — sql/030), so a country with rides but 0 known users is
 * normal and honest, not a bug.
 */
export async function countriesBreakdown(): Promise<CountryRow[]> {
  try {
    const rows = await query<{ country: string; users: number | string; rides: number | string }>(
      `WITH u AS (
          SELECT country, COUNT(*)::int AS users FROM users WHERE country IS NOT NULL GROUP BY country
       ), e AS (
          SELECT country, COUNT(*)::int AS rides FROM events WHERE country IS NOT NULL GROUP BY country
       )
       SELECT UPPER(COALESCE(u.country, e.country)) AS country,
              COALESCE(u.users, 0) AS users,
              COALESCE(e.rides, 0) AS rides
         FROM u FULL OUTER JOIN e ON e.country = u.country
        ORDER BY rides DESC, users DESC, country`,
    );
    return rows.map((r) => ({
      countryCode: r.country,
      users: Number(r.users),
      rides: Number(r.rides),
    }));
  } catch (err) {
    if (isMissingColumn(err)) {
      logger.warn({}, "admin-analytics: country columns missing — run sql/030-country.sql");
      return [];
    }
    throw err;
  }
}

/**
 * Daily PAGE_VIEW traffic (analytics_events, sql/031) — the only reads in this file that go
 * through analytics_events rather than the business tables, since traffic has no business-table
 * equivalent. Same range-bucketing idiom as dailyActivity(), NEWEST FIRST. `bots`/
 * `humanPageViews` are informational splits of `pageViews`, never subtracted from it.
 */
export async function dailyTraffic(sinceDays: number | null): Promise<TrafficDailyRow[]> {
  const rows = await query<{
    date: string;
    page_views: number | string;
    unique_visitors: number | string;
    logged_in: number | string;
    anonymous: number | string;
    bots: number | string;
    human_page_views: number | string;
  }>(
    `SELECT to_char(event_time::date, 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS page_views,
            COUNT(DISTINCT details->>'visitorId')::int AS unique_visitors,
            COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS logged_in,
            COUNT(DISTINCT details->>'visitorId') FILTER (WHERE user_id IS NULL)::int AS anonymous,
            COUNT(*) FILTER (WHERE details->>'isBot' = 'true')::int AS bots,
            COUNT(*) FILTER (WHERE details->>'isBot' IS DISTINCT FROM 'true')::int AS human_page_views
       FROM analytics_events
      WHERE event_type = 'PAGE_VIEW'
        AND ($1::int IS NULL OR event_time::date >= (CURRENT_DATE - ($1::int - 1)))
      GROUP BY event_time::date
      ORDER BY event_time::date DESC
      LIMIT 400`,
    [sinceDays],
  );
  return rows.map((r) => ({
    date: r.date,
    pageViews: Number(r.page_views),
    uniqueVisitors: Number(r.unique_visitors),
    loggedIn: Number(r.logged_in),
    anonymous: Number(r.anonymous),
    bots: Number(r.bots),
    humanPageViews: Number(r.human_page_views),
  }));
}

/** Most-viewed paths (PAGE_VIEW analytics_events) in the same range as dailyTraffic(). */
export async function topPages(sinceDays: number | null): Promise<TopPageRow[]> {
  const rows = await query<{ path: string; views: number | string; unique_visitors: number | string }>(
    `SELECT details->>'path' AS path,
            COUNT(*)::int AS views,
            COUNT(DISTINCT details->>'visitorId')::int AS unique_visitors
       FROM analytics_events
      WHERE event_type = 'PAGE_VIEW'
        AND ($1::int IS NULL OR event_time::date >= (CURRENT_DATE - ($1::int - 1)))
      GROUP BY details->>'path'
      ORDER BY views DESC
      LIMIT 20`,
    [sinceDays],
  );
  return rows.map((r) => ({
    path: r.path,
    views: Number(r.views),
    uniqueVisitors: Number(r.unique_visitors),
  }));
}
