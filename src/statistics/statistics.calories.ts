// Server-side port of elnino-client/src/lib/calories.ts's estimator, for Rider Statistics'
// lifetime/yearly calorie total — a sum over many rides, most of which no single browser was
// ever open for, so it has to run here rather than being handed a client-computed number.
//
// KEEP THIS IN SYNC WITH THE CLIENT COPY. Same MET-anchor table, same climb-bonus curve, same
// rounding. They are two files (two separate repos, no shared package) on purpose, but a change
// to the formula's shape belongs in both at once.
//
// IT IS STILL AN ESTIMATE — MET tables are population averages, not a measurement of any
// specific rider on any specific day.

/** Compendium of Physical Activities cycling brackets, pinned at their midpoints and
 *  interpolated between — a hard bracket boundary would jump the estimate by hundreds of kcal
 *  for a 0.1 km/h difference in speed. */
const MET_ANCHORS: readonly (readonly [speedKmh: number, met: number])[] = [
  [14, 4.0],
  [17.6, 6.8],
  [20.8, 8.0],
  [24.0, 10.0],
  [28.2, 12.0],
  [34.0, 15.8],
];

export function metForSpeed(kmh: number): number {
  const first = MET_ANCHORS[0];
  const last = MET_ANCHORS[MET_ANCHORS.length - 1];
  if (!Number.isFinite(kmh) || kmh <= first[0]) return first[1];
  if (kmh >= last[0]) return last[1];
  for (let i = 1; i < MET_ANCHORS.length; i++) {
    const [hiSpeed, hiMet] = MET_ANCHORS[i];
    if (kmh > hiSpeed) continue;
    const [loSpeed, loMet] = MET_ANCHORS[i - 1];
    const t = (kmh - loSpeed) / (hiSpeed - loSpeed);
    return loMet + t * (hiMet - loMet);
  }
  return last[1];
}

const MAX_CLIMB_PER_KM = 25;
const MAX_CLIMB_BONUS = 0.15;

export function climbFactor(distanceKm: number, climbM: number | null | undefined): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 1;
  const climb = climbM == null || !Number.isFinite(climbM) ? 0 : climbM;
  const perKm = Math.min(MAX_CLIMB_PER_KM, Math.max(0, climb / distanceKm));
  return 1 + (MAX_CLIMB_BONUS / MAX_CLIMB_PER_KM) * perKm;
}

export const WEIGHT_MIN_KG = 40;
export const WEIGHT_MAX_KG = 120;
export const SPEED_MIN_KMH = 20;
export const SPEED_MAX_KMH = 34;

/** Used when neither a real GPS duration nor the organizer's stated duration exists for a ride
 *  — the last-resort speed guess, by the event's own rider level. Same numbers as the client's
 *  DEFAULT_SPEED_BY_LEVEL/FALLBACK_SPEED_KMH — the organizer already chose this level to
 *  describe the ride's pace, so it is not a new invented signal, just reused here. */
const DEFAULT_SPEED_BY_LEVEL: Record<string, number> = {
  beginner: 22,
  intermediate: 25,
  masters: 28,
  elite: 31,
  world_tour: 34,
};
const FALLBACK_SPEED_KMH = 27;

export function defaultSpeedForLevel(level: string | null | undefined): number {
  return level && level in DEFAULT_SPEED_BY_LEVEL
    ? DEFAULT_SPEED_BY_LEVEL[level]
    : FALLBACK_SPEED_KMH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface CalorieInput {
  distanceKm: number | null | undefined;
  climbM: number | null | undefined;
  weightKg: number;
  speedKmh: number;
}

/**
 * Estimated kcal for one ride, rounded to the nearest 5 — printing an exact number would claim
 * a precision this formula does not have.
 *
 * `null` — not 0 — when there is no usable distance, so a caller summing many rides can `?? 0`
 * exactly once at the sum, rather than every ride needing its own branch.
 */
export function estimateCalories({
  distanceKm,
  climbM,
  weightKg,
  speedKmh,
}: CalorieInput): number | null {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  const speed = clamp(speedKmh, SPEED_MIN_KMH, SPEED_MAX_KMH);
  const weight = clamp(weightKg, WEIGHT_MIN_KG, WEIGHT_MAX_KG);
  const hours = distanceKm / speed;
  const kcal = weight * hours * metForSpeed(speed) * climbFactor(distanceKm, climbM);
  return Math.round(kcal / 5) * 5;
}
