// Small pure derivations the importer needs: a corrected climb from GPX elevation, how far a
// point is from the region its curated area maps to, and the deterministic popularity seeds.

import { createHash } from "node:crypto";
import { IL_REGIONS } from "../regions.js";

/**
 * Same hysteresis the app applies to an uploaded GPX (elnino-client/src/lib/elevation.ts, and the
 * Road importer's lib.mjs): a climb counts only once it clears NOISE_THRESHOLD_M above the last low
 * point, so GPS jitter is not summed into fake climb. Kept identical on purpose so an imported
 * track reports the number a hand upload of the same file would.
 */
export const CLIMB_NOISE_THRESHOLD_M = 5;

/** Enough of the line must have elevation for the figure to mean something. */
const MIN_ELEVATION_SAMPLES = 10;
const MIN_ELEVATION_COVERAGE = 0.5;

export interface AscentResult {
  ascentM: number | null;
  /** Why it is null, for the report. */
  reason?: "no-elevation" | "too-few-samples";
}

/** Positive accumulated ascent from the ORIGINAL elevation series (never the simplified line),
 *  or null when the file has no reliable elevation — never a made-up number. */
export function ascentFromElevations(values: readonly (number | null)[]): AscentResult {
  const series = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (series.length === 0) return { ascentM: null, reason: "no-elevation" };
  if (series.length < MIN_ELEVATION_SAMPLES || series.length / values.length < MIN_ELEVATION_COVERAGE) {
    return { ascentM: null, reason: "too-few-samples" };
  }
  let gain = 0;
  let anchor = series[0];
  for (let i = 1; i < series.length; i += 1) {
    const delta = series[i] - anchor;
    if (delta >= CLIMB_NOISE_THRESHOLD_M) {
      gain += delta;
      anchor = series[i];
    } else if (delta < 0) {
      anchor = series[i];
    }
  }
  return { ascentM: Math.round(gain) };
}

/** How far (km) a point is from a region's rough box; 0 when inside. */
export function distanceToRegionKm(regionKey: string, lat: number, lon: number): number | null {
  const region = IL_REGIONS.find((r) => r.key === regionKey);
  if (!region) return null;
  const [minLat, minLon, maxLat, maxLon] = region.bbox;
  const dLat = Math.max(minLat - lat, 0, lat - maxLat) * 110.574;
  const dLon = Math.max(minLon - lon, 0, lon - maxLon) * 111.32 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** A track further than this from its area's region is flagged for a human, not changed. The
 *  region boxes are deliberately rough, so this is set well outside their fuzz: at 20 km it
 *  catches real contradictions (a Haifa route labelled "Center") and not a trail on a border. */
export const REGION_REVIEW_KM = 20;

/** Uniform integer in [lo, hi], fully determined by `key`. Independent keys give independent
 *  values, so `${id}:likes` and `${id}:downloads` do not track each other. */
export function seededInt(key: string, lo: number, hi: number): number {
  let s = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) >>> 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return lo + Math.floor(unit * (hi - lo + 1));
}

/** Imported starting popularity, kept apart from real user actions (routes.seed_*_count, sql/043). */
export const SEED_MIN = 0;
export const SEED_MAX = 79;

export function seedCounts(sourceKey: string): { likes: number; downloads: number } {
  return {
    likes: seededInt(`${sourceKey}:seed-likes`, SEED_MIN, SEED_MAX),
    downloads: seededInt(`${sourceKey}:seed-downloads`, SEED_MIN, SEED_MAX),
  };
}
