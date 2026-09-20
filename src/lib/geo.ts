// Shared geometry helpers: distance, bounding boxes and simplification. Written once here
// because both the routes module (distance/elevation/bbox at upload) and the tracking
// module (distance travelled, saved-track simplification) need the same math.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two points, in kilometres. */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Sum of the distance between every consecutive pair of points. */
export function sumDistanceKm(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistanceKm(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Total climb: the sum of every positive elevation delta between consecutive points. Null
 * when none of the points carry elevation, so callers can distinguish "flat" from "unknown".
 */
export function sumClimbMeters(elevations: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let sawElevation = false;
  for (let i = 1; i < elevations.length; i++) {
    const prev = elevations[i - 1];
    const curr = elevations[i];
    if (prev == null || curr == null) continue;
    sawElevation = true;
    const delta = curr - prev;
    if (delta > 0) total += delta;
  }
  return sawElevation ? total : null;
}

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function computeBbox(points: readonly LatLng[]): Bbox | null {
  if (points.length === 0) return null;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLon = points[0].lng;
  let maxLon = points[0].lng;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLon) minLon = p.lng;
    if (p.lng > maxLon) maxLon = p.lng;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Geometry-aware simplification to AT MOST `maxCount` points — the indices (ascending) of the
 * points to keep, first and last always among them.
 *
 * Douglas-Peucker run as a priority split rather than with a tolerance: the segment whose worst
 * point sits farthest from its chord is split at that point, again and again, until `maxCount`
 * points are kept. Each split spends a point where the line deviates most, so a switchback
 * section keeps many and a straight fire road keeps two — unlike simplifyByStride, which spends
 * them evenly and cuts every corner. A count target (not a tolerance) is what a fixed-size
 * card preview needs; lib/mtb-import/simplify.ts is the tolerance-driven sibling that builds
 * the stored display line.
 *
 * Distances are measured on a local flat projection (longitude scaled by cos(latitude)), which
 * is exact enough for one ride's extent. Iterative, so a 30,000-point trace cannot overflow the
 * stack, and O(n) per split over the segment being split.
 */
export function simplifyIndicesToCount(points: readonly LatLng[], maxCount: number): number[] {
  const n = points.length;
  if (n <= maxCount) return points.map((_, i) => i);
  // A line needs two ends; asking for fewer still returns them.
  if (maxCount < 2) return n > 1 ? [0, n - 1] : [0];

  const kx = Math.cos(toRadians(points[0].lat)) * 111_320;
  const ky = 110_540;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i].lng * kx;
    ys[i] = points[i].lat * ky;
  }

  interface Span {
    start: number;
    end: number;
    /** Index of the point farthest from the chord start-end, or -1 when there is none. */
    worst: number;
    worstDistance: number;
  }

  const measure = (start: number, end: number): Span => {
    const dx = xs[end] - xs[start];
    const dy = ys[end] - ys[start];
    const lengthSq = dx * dx + dy * dy;
    let worst = -1;
    let worstDistance = 0;
    for (let i = start + 1; i < end; i++) {
      let t = lengthSq === 0 ? 0 : ((xs[i] - xs[start]) * dx + (ys[i] - ys[start]) * dy) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(xs[i] - (xs[start] + t * dx), ys[i] - (ys[start] + t * dy));
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    return { start, end, worst, worstDistance };
  };

  const kept = new Set<number>([0, n - 1]);
  let spans: Span[] = [measure(0, n - 1)];
  while (kept.size < maxCount) {
    let best = -1;
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].worst !== -1 && (best === -1 || spans[i].worstDistance > spans[best].worstDistance)) {
        best = i;
      }
    }
    // Every remaining point lies exactly on its chord (a stationary or dead-straight trace):
    // nothing left worth keeping.
    if (best === -1) break;
    const span = spans[best];
    kept.add(span.worst);
    spans = [
      ...spans.slice(0, best),
      measure(span.start, span.worst),
      measure(span.worst, span.end),
      ...spans.slice(best + 1),
    ];
  }
  return [...kept].sort((a, b) => a - b);
}

/**
 * Cheap downsampling: keeps roughly `maxCount` evenly-spaced points, always including the
 * first and last. Used for participant_tracks and route preview_points. Real
 * Douglas-Peucker simplification is a documented future improvement — not required for v1,
 * since neither consumer needs geometric fidelity, only "roughly this shape, few points".
 */
export function simplifyByStride<T>(points: readonly T[], maxCount: number): T[] {
  if (points.length <= maxCount || maxCount < 2) return [...points];
  const stride = (points.length - 1) / (maxCount - 1);
  const result: T[] = [];
  for (let i = 0; i < maxCount; i++) {
    result.push(points[Math.round(i * stride)]);
  }
  return result;
}
