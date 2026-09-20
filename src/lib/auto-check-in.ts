// The auto check-in decision, as a pure function: no database, no clock of its own, no config
// import. The service gathers the facts and passes them in, which is what lets every branch be
// tested without a database — see auto-check-in.test.ts.

import type { AutoCheckInConfig } from "../config/auto-check-in.js";
import { haversineDistanceKm, type LatLng } from "./geo.js";

/**
 * Why a check-in did or did not happen. Returned to the client as-is, so these are API values:
 * add to the list, never rename one.
 *
 *   arrived           the fix passed every test
 *   disabled          the organizer switched auto check-in off for this ride
 *   closed            the ride is cancelled or finished
 *   outside_window    too early or too late for this ride's start time
 *   no_start_point    the ride has no start time or no route, so there is nothing to be near
 *   inaccurate        the fix's own error circle is wider than the configured maximum
 *   too_far           a good fix, but not within the radius of the start point
 */
export type AutoCheckInDecision =
  | "arrived"
  | "disabled"
  | "closed"
  | "outside_window"
  | "no_start_point"
  | "inaccurate"
  | "too_far";

export interface AutoCheckInFacts {
  autoCheckIn: boolean;
  status: string;
  startsAt: Date | null;
  /** The route's first point, or null when the ride has no route. */
  startPoint: LatLng | null;
  now: Date;
  position: LatLng;
  /** The fix's own reported error radius in metres. Absent means the device did not say. */
  accuracyM?: number | null;
}

export interface AutoCheckInResult {
  decision: AutoCheckInDecision;
  /** Straight-line distance to the start point in whole metres, when it was computed. */
  distanceM: number | null;
}

const CLOSED_STATUSES = new Set(["cancelled", "finished"]);

/**
 * Order matters and is deliberate: cheap, ride-level answers first (so a rider far from a ride
 * whose check-in is off is told "disabled", not "too far"), and the position test last.
 *
 * `distanceM` is filled in only once a distance has actually been measured — for `too_far`
 * and `arrived`, and for `inaccurate` when a distance is still worth reporting. It is never a
 * guess.
 */
export function evaluateAutoCheckIn(
  facts: AutoCheckInFacts,
  config: AutoCheckInConfig,
): AutoCheckInResult {
  const none = (decision: AutoCheckInDecision): AutoCheckInResult => ({
    decision,
    distanceM: null,
  });

  if (!facts.autoCheckIn) return none("disabled");
  if (CLOSED_STATUSES.has(facts.status)) return none("closed");
  if (facts.startsAt === null || facts.startPoint === null) return none("no_start_point");

  const offsetMs = Math.abs(facts.now.getTime() - facts.startsAt.getTime());
  if (offsetMs > config.windowMin * 60_000) return none("outside_window");

  const distanceM = Math.round(haversineDistanceKm(facts.position, facts.startPoint) * 1000);

  // A fix that says "within 800 m" cannot prove anything about 100 m. Refuse it rather than
  // accept a coarse network-derived position that happens to land near the start.
  if (
    facts.accuracyM !== undefined &&
    facts.accuracyM !== null &&
    facts.accuracyM > config.maxAccuracyM
  ) {
    return { decision: "inaccurate", distanceM };
  }

  if (distanceM > config.radiusM) return { decision: "too_far", distanceM };
  return { decision: "arrived", distanceM };
}
