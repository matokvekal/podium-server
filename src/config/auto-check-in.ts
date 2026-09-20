// The auto check-in rules, in one place. See sql/040-auto-check-in.sql for what the feature is.
//
// A rider on the start list is marked "arrived" (attendance_source = 'auto') when, in ONE
// request, all of these hold:
//   - the ride has auto check-in switched on (events.auto_check_in)
//   - now is within `windowMin` minutes either side of the ride's start time
//   - the rider's own GPS fix is within `radiusM` metres of the route's start point
//   - that fix is no less precise than `maxAccuracyM`
//
// Every number is an env var (config/env.ts) so it can be tuned without a deploy of code, and
// none is stored per ride: an organizer chooses whether to use the feature, not how strict it is.

import { env } from "./env.js";

export interface AutoCheckInConfig {
  /** How close to the start point, in metres, the rider's fix must be. */
  radiusM: number;
  /** Minutes either side of the start time during which a check-in is accepted. */
  windowMin: number;
  /** The widest GPS error circle, in metres, a fix may report and still count. */
  maxAccuracyM: number;
}

export const AUTO_CHECK_IN: AutoCheckInConfig = {
  radiusM: env.AUTO_CHECK_IN_RADIUS_M,
  windowMin: env.AUTO_CHECK_IN_WINDOW_MIN,
  maxAccuracyM: env.AUTO_CHECK_IN_MAX_ACCURACY_M,
};
