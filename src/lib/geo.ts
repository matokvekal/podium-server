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
