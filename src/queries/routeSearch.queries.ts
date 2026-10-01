// SQL for routes.ai_search_text and events.route_info_processed (sql/057) — folding a ride's
// track-related details into the shared route's search text. What the text says and how it is
// merged is lib/route-search-text.ts; this file only reads, locks and writes.
//
// THE ORDER IS THE CONTRACT. One transaction per ride: lock the ride, lock its route, write the
// route's text, and only then set events.route_info_processed = true. Anything that throws rolls
// both back, so a ride is never marked processed without its route having been written.
//
// The ride is read as `to_jsonb(e)` rather than a column list on purpose: production has been
// missing optional events columns before (region, sql/032), and a missing column must leave that
// one field out of the text — not fail every ride with 42703.

import { execute, query, queryOne, type Transaction, withTransaction } from "../db/pool.js";
import {
  AI_SEARCH_TEXT_VERSION,
  type EventSearchSource,
  eventFragments,
  isEventEligibleForRouteText,
  mergeSearchText,
  type RouteSearchSource,
  routeFragments,
} from "../lib/route-search-text.js";

/** The publicly-listed rule, as SQL. Must match isEventEligibleForRouteText. */
const ELIGIBLE_SQL = `e.visibility = 'public' AND e.status NOT IN ('draft', 'cancelled')`;

type EventJson = Partial<EventSearchSource> & {
  id: string;
  visibility: string;
  status: string;
  route_info_processed?: boolean;
};

interface RouteSearchRow extends RouteSearchSource {
  ai_search_text: string | null;
}

function toEventSource(ev: EventJson): EventSearchSource {
  return {
    name: ev.name ?? null,
    description: ev.description ?? null,
    location: ev.location ?? null,
    area: ev.area ?? null,
    region: ev.region ?? null,
    country: ev.country ?? null,
    activity_type: ev.activity_type ?? null,
    level: ev.level ?? null,
    route_difficulty: ev.route_difficulty ?? null,
    season: ev.season ?? null,
    shade: ev.shade ?? null,
    terrain_grade: ev.terrain_grade ?? null,
    is_accessible: ev.is_accessible ?? null,
  };
}

/** The route's new text after this ride, or null when the ride adds nothing new. */
export function buildMergedSearchText(route: RouteSearchRow, ev: EventJson): string | null {
  return mergeSearchText(route.ai_search_text, [
    ...routeFragments(route),
    ...eventFragments(toEventSource(ev)),
  ]);
}

export type RouteSearchOutcome =
  /** The route's text grew; the ride is now marked processed. */
  | "merged"
  /** Everything this ride says was already there; the ride is now marked processed. */
  | "unchanged"
  /** Already processed — nothing done. */
  | "already-processed"
  /** No event_routes row — nothing to fold into; left unprocessed. */
  | "no-route"
  /** Not publicly listed — its details stay out of search; left unprocessed. */
  | "ineligible"
  /** No such ride. */
  | "not-found";

export interface RouteSearchResult {
  outcome: RouteSearchOutcome;
  routeId: number | null;
}

async function lockEventWithRoute(
  tx: Transaction,
  eventId: string,
): Promise<{ ev: EventJson; routeId: number | null } | null> {
  const row = await tx.queryOne<{ ev: EventJson; route_id: string | number | null }>(
    `SELECT to_jsonb(e) AS ev,
            (SELECT er.route_id FROM event_routes er
              WHERE er.event_id = e.id
              ORDER BY er.created_at DESC
              LIMIT 1) AS route_id
       FROM events e
      WHERE e.id = $1
      FOR UPDATE OF e`,
    [eventId],
  );
  if (!row) return null;
  return { ev: row.ev, routeId: row.route_id === null ? null : Number(row.route_id) };
}

/**
 * Folds one ride into its route's ai_search_text and marks the ride processed — in that order,
 * in one transaction. Throws on any database error (and so commits nothing); every "nothing to
 * do" case is an outcome, not an error.
 */
export async function applyEventToRouteSearchText(eventId: string): Promise<RouteSearchResult> {
  return withTransaction(async (tx) => {
    const locked = await lockEventWithRoute(tx, eventId);
    if (!locked) return { outcome: "not-found", routeId: null };
    const { ev, routeId } = locked;
    if (ev.route_info_processed === true) return { outcome: "already-processed", routeId };
    if (routeId === null) return { outcome: "no-route", routeId: null };
    if (!isEventEligibleForRouteText(ev)) return { outcome: "ineligible", routeId };

    const route = await tx.queryOne<RouteSearchRow>(
      `SELECT name, place_name, route_type, ai_search_text
         FROM routes
        WHERE id = $1
        FOR UPDATE`,
      [routeId],
    );
    if (!route) return { outcome: "no-route", routeId: null };

    const merged = buildMergedSearchText(route, ev);
    if (merged !== null) {
      await tx.query(
        `UPDATE routes
            SET ai_search_text = $2,
                ai_search_updated_at = NOW(),
                ai_search_version = $3
          WHERE id = $1`,
        [routeId, merged, AI_SEARCH_TEXT_VERSION],
      );
    }
    // Only now — after the route write above has succeeded.
    await tx.query(
      "UPDATE events SET route_info_processed = TRUE WHERE id = $1 AND route_info_processed = FALSE",
      [eventId],
    );
    return { outcome: merged !== null ? "merged" : "unchanged", routeId };
  });
}

/**
 * A ride now runs on a route it did not create (Find Tracks pick, or copied from another ride):
 * its details are left for the later enrichment step, so it must read as unprocessed — even if
 * it was processed against the route it had before. Never touches the route's text.
 */
export async function markEventRouteInfoPending(eventId: string): Promise<void> {
  await execute(
    "UPDATE events SET route_info_processed = FALSE WHERE id = $1 AND route_info_processed = TRUE",
    [eventId],
  );
}

// ─── backfill reads ─────────────────────────────────────────────────────────────────────────

export interface RouteSearchBacklog {
  /** Unprocessed rides that are publicly listed and have a route — what the backfill takes. */
  eligible: number;
  /** Distinct routes those rides point at. */
  eligibleRoutes: number;
  /** Unprocessed rides with no route attached — skipped, stay unprocessed. */
  noRoute: number;
  /** Unprocessed rides with a route but not publicly listed — skipped, stay unprocessed. */
  notPublic: number;
}

export async function selectRouteSearchBacklog(): Promise<RouteSearchBacklog> {
  const row = await queryOne<Record<keyof RouteSearchBacklog, string>>(
    `WITH pending AS (
       SELECT e.id,
              (${ELIGIBLE_SQL}) AS eligible,
              (SELECT er.route_id FROM event_routes er
                WHERE er.event_id = e.id
                ORDER BY er.created_at DESC
                LIMIT 1) AS route_id
         FROM events e
        WHERE e.route_info_processed = FALSE
     )
     SELECT count(*) FILTER (WHERE eligible AND route_id IS NOT NULL)                   AS "eligible",
            count(DISTINCT route_id) FILTER (WHERE eligible AND route_id IS NOT NULL)   AS "eligibleRoutes",
            count(*) FILTER (WHERE route_id IS NULL)                                    AS "noRoute",
            count(*) FILTER (WHERE NOT eligible AND route_id IS NOT NULL)               AS "notPublic"
       FROM pending`,
  );
  return {
    eligible: Number(row?.eligible ?? 0),
    eligibleRoutes: Number(row?.eligibleRoutes ?? 0),
    noRoute: Number(row?.noRoute ?? 0),
    notPublic: Number(row?.notPublic ?? 0),
  };
}

export interface PendingRouteSearchEvent {
  ev: EventJson;
  routeId: number;
}

/**
 * The next page of rides the backfill should take, keyset-paged by (created_at, id) so the
 * oldest ride on a route seeds its text first. Read-only — the write re-checks everything
 * under a lock (applyEventToRouteSearchText).
 */
export async function selectPendingRouteSearchEvents(
  after: { createdAt: string; id: string } | null,
  limit: number,
): Promise<Array<PendingRouteSearchEvent & { createdAt: string }>> {
  const rows = await query<{ ev: EventJson; route_id: string | number; created_at: string }>(
    `SELECT to_jsonb(e) AS ev, x.route_id, e.created_at::text AS created_at
       FROM events e
       JOIN LATERAL (
              SELECT er.route_id FROM event_routes er
               WHERE er.event_id = e.id
               ORDER BY er.created_at DESC
               LIMIT 1) x ON TRUE
      WHERE e.route_info_processed = FALSE
        AND ${ELIGIBLE_SQL}
        AND ($1::timestamptz IS NULL OR (e.created_at, e.id) > ($1::timestamptz, $2::uuid))
      ORDER BY e.created_at, e.id
      LIMIT $3`,
    [after?.createdAt ?? null, after?.id ?? null, limit],
  );
  return rows.map((r) => ({ ev: r.ev, routeId: Number(r.route_id), createdAt: r.created_at }));
}

/** Current search text for a set of routes — the dry run's starting point. */
export async function selectRouteSearchRows(
  routeIds: readonly number[],
): Promise<Map<number, RouteSearchRow>> {
  const out = new Map<number, RouteSearchRow>();
  if (routeIds.length === 0) return out;
  const rows = await query<RouteSearchRow & { id: string | number }>(
    `SELECT id, name, place_name, route_type, ai_search_text
       FROM routes
      WHERE id = ANY($1::bigint[])`,
    [routeIds],
  );
  for (const r of rows) out.set(Number(r.id), r);
  return out;
}
