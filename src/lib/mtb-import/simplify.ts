// Geometry-aware simplification for the DB / display line of an imported track.
//
// The ORIGINAL GPX is never touched — it is stored byte-for-byte for download. This builds the
// separate, smaller line the map and the API use.
//
// WHY DOUGLAS-PEUCKER WITH A TOLERANCE IN METRES, NOT "EVERY Nth POINT" OR A TARGET COUNT
//   The project's only existing simplifier is simplifyByStride (lib/geo.ts) — evenly spaced points,
//   which cuts corners on winding single-track and wastes points on a straight fire road, and
//   whose own header calls Douglas-Peucker "a documented future improvement". Here a point
//   survives only if dropping it would move the line more than `toleranceM` from where it was, so:
//     - a long straight section keeps a couple of points,
//     - a tight switchback section keeps many,
//     - a longer, more complex route ends up with more points than a short simple one,
//   and no route is forced to a fixed count.
//
// The ONLY count-based rule is a safety ceiling for pathological input (a GPS trace that jitters
// over 10 000 points at 8 m). It relaxes the tolerance until the ceiling holds; normal tracks
// never reach it and are decided purely by their shape.

import type { GpxPoint } from "./gpx.js";

/** Default deviation allowed from the original line, in metres. Inside GPS noise for a phone. */
export const DEFAULT_TOLERANCE_M = 8;
/** Backstop against pathological data only — see the header. Not a target. */
export const DEFAULT_CEILING_POINTS = 5000;

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Local flat projection (metres) about the line's own centre. Equirectangular is exact enough for
 *  a tolerance of metres over a track that spans tens of kilometres at Israeli latitudes. */
function project(points: readonly { lat: number; lng: number }[]) {
  let latSum = 0;
  let lngSum = 0;
  for (const p of points) {
    latSum += p.lat;
    lngSum += p.lng;
  }
  const lat0 = latSum / Math.max(points.length, 1);
  const lng0 = lngSum / Math.max(points.length, 1);
  const kx = EARTH_RADIUS_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_RADIUS_M * RAD;
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    xs[i] = (points[i].lng - lng0) * kx;
    ys[i] = (points[i].lat - lat0) * ky;
  }
  return { xs, ys };
}

/** Distance from point p to the SEGMENT a-b (not the infinite line), so a hairpin whose apex lies
 *  beyond the segment's end is still measured against the end. */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Indices (ascending) of the points to keep. Iterative, so a 30 000-point track cannot overflow
 * the call stack. First and last are always kept.
 */
export function douglasPeuckerIndices(
  points: readonly { lat: number; lng: number }[],
  toleranceM: number,
): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);

  const { xs, ys } = project(points);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    if (b - a < 2) continue;
    let worst = -1;
    let worstDistance = toleranceM;
    for (let i = a + 1; i < b; i += 1) {
      const d = distanceToSegment(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b]);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }

  const kept: number[] = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) kept.push(i);
  return kept;
}

export interface SimplifyResult {
  /** The kept points, in order, elevation carried along where the source had it. */
  points: GpxPoint[];
  /** Their indices in the input. */
  indices: number[];
  /** The tolerance actually applied — larger than requested only when the ceiling forced it. */
  toleranceM: number;
  /** True when the ceiling had to relax the tolerance (pathological data). */
  ceilingApplied: boolean;
}

export function simplifyRoute(
  points: readonly GpxPoint[],
  options: { toleranceM?: number; ceilingPoints?: number } = {},
): SimplifyResult {
  const requested = options.toleranceM ?? DEFAULT_TOLERANCE_M;
  const ceiling = Math.max(options.ceilingPoints ?? DEFAULT_CEILING_POINTS, 2);

  let toleranceM = requested;
  let indices = douglasPeuckerIndices(points, toleranceM);
  let ceilingApplied = false;
  while (indices.length > ceiling) {
    ceilingApplied = true;
    toleranceM *= 1.5;
    indices = douglasPeuckerIndices(points, toleranceM);
  }
  return { points: indices.map((i) => points[i]), indices, toleranceM, ceilingApplied };
}

/** A card-sized line derived FROM the simplified one, by the same algorithm with a tolerance
 *  raised until it fits `target`. Used for routes.preview_points. */
export function previewLine(points: readonly GpxPoint[], target = 300): GpxPoint[] {
  if (points.length <= target) return [...points];
  let toleranceM = DEFAULT_TOLERANCE_M * 2;
  let indices = douglasPeuckerIndices(points, toleranceM);
  while (indices.length > target) {
    toleranceM *= 1.5;
    indices = douglasPeuckerIndices(points, toleranceM);
  }
  return indices.map((i) => points[i]);
}

export interface DeviationStats {
  /** The worst any ORIGINAL point sits from the simplified line, metres. */
  maxM: number;
  meanM: number;
  /** Share of original points within `toleranceM`. */
  withinToleranceShare: number;
}

/** How faithfully `kept` (ascending indices into `points`) follows the original line. Measured,
 *  not assumed: every dropped point against the simplified segment that replaced it. */
export function measureDeviation(
  points: readonly { lat: number; lng: number }[],
  kept: readonly number[],
  toleranceM: number,
): DeviationStats {
  const { xs, ys } = project(points);
  let maxM = 0;
  let sum = 0;
  let within = 0;
  for (let k = 0; k < kept.length - 1; k += 1) {
    const a = kept[k];
    const b = kept[k + 1];
    for (let i = a + 1; i < b; i += 1) {
      const d = distanceToSegment(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b]);
      if (d > maxM) maxM = d;
      sum += d;
      if (d <= toleranceM + 1e-9) within += 1;
    }
  }
  const dropped = points.length - kept.length;
  return {
    maxM,
    meanM: dropped > 0 ? sum / dropped : 0,
    withinToleranceShare: dropped > 0 ? within / dropped : 1,
  };
}
