// TRACK SEARCH — preparing a rider's free-text query for GET /events/public.
//
// Two layers, and only the first is required:
//
//   1. LEXICAL (always). lib/track-search.ts turns the text into word groups; the SQL in
//      selectPublicEvents decides which rows MATCH (every word, any order, partial, typo-tolerant
//      via pg_trgm), applies every filter, pages, and ranks. This is the whole search today.
//
//   2. RANKERS (optional, none registered today). A ranker scores routes for the query — the
//      intended first one is semantic: embed the query, compare it with an embedding of each
//      route's ai_search_text (pgvector, a local model, an external service — the interface does
//      not care). Its scores are passed into the SAME SQL as `boosts`, where they only add to the
//      ranking of rows the lexical layer already matched.
//
// WHAT A RANKER CAN NEVER DO, by construction rather than by convention:
//   - change which rows are returned, the filters, the total, or the paging — the boosts reach
//     only the ORDER BY (TRACK_SEARCH_BOOST_WEIGHT in event.queries.ts);
//   - change the response — EventListItem is built exactly as before;
//   - slow a search past RANKER_TIMEOUT_MS or fail it: a ranker that throws, times out, or
//     returns garbage is logged and ignored, and the search runs lexical-only.
//
// To add one later: implement TrackSearchRanker and call registerTrackSearchRanker at startup
// (behind a config flag). Nothing in the controller, the API or the client changes.

import { logger } from "../lib/logger.js";
import {
  buildTrackSearch,
  MAX_ROUTE_BOOSTS,
  type RouteBoost,
  type TrackSearch,
} from "../lib/track-search.js";

/** A ranker gets this long per search; past it the search goes ahead without its scores. */
export const RANKER_TIMEOUT_MS = 300;

export interface TrackSearchRanker {
  /** For logs. */
  readonly name: string;
  /**
   * Scores for routes relevant to `query` (0..1, higher = more relevant). Return only routes
   * worth boosting — not every route. Must honour `signal`: it aborts at RANKER_TIMEOUT_MS.
   */
  scoreRoutes(query: string, signal: AbortSignal): Promise<RouteBoost[]>;
}

const rankers: TrackSearchRanker[] = [];

export function registerTrackSearchRanker(ranker: TrackSearchRanker): void {
  rankers.push(ranker);
}

/** Tests only. */
export function clearTrackSearchRankers(): void {
  rankers.length = 0;
}

function isValidBoost(b: unknown): b is RouteBoost {
  if (typeof b !== "object" || b === null) return false;
  const { routeId, score } = b as { routeId?: unknown; score?: unknown };
  return (
    Number.isSafeInteger(routeId) &&
    (routeId as number) > 0 &&
    typeof score === "number" &&
    Number.isFinite(score)
  );
}

async function runRanker(ranker: TrackSearchRanker, query: string): Promise<RouteBoost[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${RANKER_TIMEOUT_MS} ms`));
    }, RANKER_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([ranker.scoreRoutes(query, controller.signal), timeout]);
    return Array.isArray(result) ? result.filter(isValidBoost) : [];
  } catch (err) {
    logger.warn({ err, ranker: ranker.name }, "track search ranker failed — lexical ranking only");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The search for `q`: the lexical groups, plus boosts from any registered rankers (summed per
 * route, capped at 1 — each ranker's 0..1 is a vote, not a scale). null when `q` holds nothing
 * searchable, exactly as buildTrackSearch.
 */
export async function prepareTrackSearch(q: string | undefined): Promise<TrackSearch | null> {
  const search = buildTrackSearch(q);
  if (!search || rankers.length === 0 || q === undefined) return search;

  const results = await Promise.all(rankers.map((r) => runRanker(r, q)));
  const byRoute = new Map<number, number>();
  for (const boosts of results) {
    for (const { routeId, score } of boosts) {
      byRoute.set(routeId, Math.min(1, (byRoute.get(routeId) ?? 0) + Math.max(0, score)));
    }
  }
  if (byRoute.size === 0) return search;
  const boosts = [...byRoute]
    .map(([routeId, score]) => ({ routeId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROUTE_BOOSTS);
  return { ...search, boosts };
}
