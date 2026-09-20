// AUTO-FINISH — closes rides nobody finished.
//
// Until now a ride only became status='finished' when its organizer pressed Finish. Everywhere
// else in the app a ride whose end time has passed already READS as finished
// (computeEffectiveStatus in event.service.ts), but nothing wrote the column — so a ride the
// organizer forgot was never really over: no saved rider lines, and no Statistics for anyone on
// its start list. This sweeper is the write that was missing.
//
// THE RULE: a ride that is still published / registration_open / ready / live one full day after
// its end time (its start time when no end was set) is finished. One day, not "the moment it
// ends", so an organizer who is a little late pressing Finish still gets to (that finish also
// stamps a real finished_at); the sweep is the safety net, not the normal path.
//
// finished_at is the RIDE'S OWN end time, not the moment of the sweep. That is what puts the ride
// in the month it was actually ridden in, which is what Statistics groups by.
//
// AFTER A ROW FLIPS it gets the same two follow-ups the organizer's Finish gives it:
//   1. writeParticipantTracks — reduce each rider's raw points to one saved line. Time-critical:
//      location_points is purge-eligible and participant_tracks is not (track-writer.ts).
//   2. refreshStatsForFinishedEvent — recompute every rider's Statistics right away.
//
// SAFE TO RUN ON EVERY NODE, EVERY TIME: the flip is a guarded UPDATE (autoFinishEvent), so two
// overlapping sweeps — or a sweep racing an organizer — finish a ride exactly once; the loser
// gets `false` and skips the follow-ups.
//
// FIRST SWEEP AFTER DEPLOY works through the whole backlog of old never-finished rides, oldest
// first, BATCH_SIZE per pass, one pass per tick until it is clear. Each of those rides was already
// displayed as finished; this makes it true in the database.

import { logger } from "../lib/logger.js";
import { autoFinishEvent, selectEventsDueForAutoFinish } from "../queries/event.queries.js";
import { refreshStatsForFinishedEvent } from "../statistics/statistics.service.js";
import { writeParticipantTracks } from "./track-writer.js";

/** How long after a ride's end it is left for its organizer before the sweeper closes it. */
export const AUTO_FINISH_GRACE_HOURS = 24;
export const AUTO_FINISH_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
const BATCH_SIZE = 50;

/** One pass. Returns how many rides it finished. Never throws — a bad row is logged and skipped. */
export async function runAutoFinishSweep(): Promise<number> {
  let due: Awaited<ReturnType<typeof selectEventsDueForAutoFinish>>;
  try {
    due = await selectEventsDueForAutoFinish(AUTO_FINISH_GRACE_HOURS, BATCH_SIZE);
  } catch (err) {
    logger.warn({ err }, "auto-finish: could not list rides due to finish");
    return 0;
  }

  let finished = 0;
  for (const candidate of due) {
    try {
      const flipped = await autoFinishEvent(candidate.id, candidate.rideEndedAt);
      if (!flipped) continue; // an organizer got there first
      finished += 1;
      logger.info(
        { eventId: candidate.id, from: candidate.status, finishedAt: candidate.rideEndedAt },
        "auto-finish: ride finished",
      );
      await writeParticipantTracks(candidate.id);
      await refreshStatsForFinishedEvent(candidate.id);
    } catch (err) {
      logger.warn({ err, eventId: candidate.id }, "auto-finish: failed for one ride");
    }
  }
  return finished;
}

/** Start the periodic sweep. Returns a stop function. Timers are unref'd: they never keep the
 *  process alive on their own, so shutdown is not held up by a sleeping sweeper. */
export function startAutoFinishSweeper(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow pass must not stack up behind itself
    running = true;
    try {
      const n = await runAutoFinishSweep();
      if (n > 0) logger.info({ finished: n }, "auto-finish: sweep complete");
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS);
  const every = setInterval(() => void tick(), AUTO_FINISH_INTERVAL_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
