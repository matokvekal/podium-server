// THE TINY ROUTE PREVIEW — routes.thumb_points (sql/046-route-thumb.sql).
//
// A Find Tracks / My Rides card draws its route from this and nothing else, so it travels INSIDE
// the paginated list response and a scrolling rider costs one request per page, not one per
// card. It is a display line only: the detailed line is routes.track_points (GET
// /events/:id/route, fetched when a rider opens or explores a route) and the original file is
// route_gpx_files (GET /routes/:id/gpx). Neither is read or changed here.
//
// SIZE. 60 points, coordinates to 5 decimals (~1 m), elevation to whole metres: about 1.2 KB of
// JSON per route (~0.4 KB gzipped) plus roughly 0.25 KB for the elevation series. 60 was measured
// against all 1,007 imported MTB routes — median worst deviation 0.7% of the route's extent,
// p90 1.35%, which is ~2 px and ~4 px on a card-sized map. 40 visibly cuts corners on twisty
// single-track; 80 costs a third more for a difference nobody can see at that size.
//
// STORED SHAPE  { "p": [[lat, lng], ...], "e": [metres | null, ...] }   ("e" omitted when the
// route has no elevation). API SHAPE  { points, elevations? } — the client's EventRoute fields.

import { type LatLng, simplifyIndicesToCount } from "./geo.js";

/** Points kept in a preview. See the header for why 60. */
export const THUMB_POINT_TARGET = 60;

export type PreviewPoint = [number, number];

/** What a list row carries as `preview`. */
export interface RoutePreview {
  points: PreviewPoint[];
  /** One entry per point, whole metres, null where that point had no reading. Omitted entirely
   *  when the route has no elevation, so the profile is skipped rather than drawn flat. */
  elevations?: (number | null)[];
}

/** The routes.thumb_points column value. */
export interface StoredThumb {
  p: PreviewPoint[];
  e?: (number | null)[];
}

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

/**
 * Builds the preview from a line and, optionally, its per-point elevations (same length, same
 * order). Null when there is no line to draw — fewer than two finite points.
 */
export function buildRoutePreview(
  points: readonly LatLng[],
  elevations: readonly (number | null | undefined)[] | null,
): RoutePreview | null {
  // A point that is not finite would poison the projection; drop it, and its elevation with it
  // so the two arrays cannot slip out of step.
  const line: LatLng[] = [];
  const ele: (number | null)[] = [];
  for (let i = 0; i < points.length; i++) {
    const { lat, lng } = points[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    line.push({ lat, lng });
    const e = elevations?.[i];
    ele.push(typeof e === "number" && Number.isFinite(e) ? Math.round(e) : null);
  }
  if (line.length < 2) return null;

  const kept = simplifyIndicesToCount(line, THUMB_POINT_TARGET);
  const preview: RoutePreview = {
    points: kept.map((i) => [round5(line[i].lat), round5(line[i].lng)]),
  };
  if (ele.some((e) => e !== null)) preview.elevations = kept.map((i) => ele[i]);
  return preview;
}

/** The column value for a preview, or null (store NOTHING) when there is none. */
export function toStoredThumb(preview: RoutePreview | null): StoredThumb | null {
  if (!preview) return null;
  return preview.elevations ? { p: preview.points, e: preview.elevations } : { p: preview.points };
}

function isPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/**
 * Reads either stored shape back into a preview — the read side of the "two shapes" rule that
 * governs track_points / preview_points (see eventRoute.queries.ts):
 *
 *   { p, e }                       a routes.thumb_points value: already 60 points or fewer, used
 *                                  as it is.
 *   [[lat, lng], …] or             a routes.preview_points value (up to 300 points; tuples, or
 *   [{ lat, lng, ele? }, …]        objects when the route carries elevation): simplified here.
 *                                  This is the fallback for a route whose thumb_points has not
 *                                  been backfilled yet, so a list is never blank for want of one.
 *
 * Null for anything unusable — a card with no route is a normal state, not an error.
 */
export function previewFromStored(value: unknown): RoutePreview | null {
  if (value === null || value === undefined) return null;

  if (!Array.isArray(value)) {
    if (typeof value !== "object") return null;
    const { p, e } = value as { p?: unknown; e?: unknown };
    if (!Array.isArray(p)) return null;
    const points = p.filter(isPair);
    if (points.length < 2) return null;
    // Trust the column's own alignment only when it is intact; a mismatch drops the series
    // rather than attributing elevations to the wrong places.
    const elevations =
      Array.isArray(e) && e.length === p.length && points.length === p.length
        ? (e as (number | null)[])
        : null;
    return elevations ? { points, elevations } : { points };
  }

  const line: LatLng[] = [];
  const ele: (number | null)[] = [];
  for (const item of value) {
    if (isPair(item)) {
      line.push({ lat: item[0], lng: item[1] });
      ele.push(null);
    } else if (typeof item === "object" && item !== null) {
      const { lat, lng, ele: e } = item as { lat?: unknown; lng?: unknown; ele?: unknown };
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      line.push({ lat, lng });
      ele.push(typeof e === "number" ? e : null);
    }
  }
  return buildRoutePreview(line, ele);
}

/** A Postgres 42703 caused by routes.thumb_points not existing yet (sql/046 not run). */
export function isMissingThumbColumn(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === "42703" && typeof message === "string" && message.includes("thumb_points");
}
