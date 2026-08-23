// The finish hook: at live -> finished, reduce each rider's raw points to one saved line.
//
// Deliberately its own file, separate from results.service.ts. The read half of results needs
// getEventForViewer from the events module, and the events module needs THIS — putting both
// halves in one file makes events and results import each other. ESM tolerates that as long
// as nothing runs at module load, which is exactly the kind of thing that stops being true
// later, silently, as an `undefined is not a function` at startup.
//
// ⚠ This is the time-critical half of the whole results feature. location_points is
// purge-eligible (config/env.ts) and participant_tracks is never purged
// (sql/005-tracking.sql): once the purge runs for an event whose tracks were never written,
// that ride's history is gone permanently.

import type { TrackPoint } from "../db/types.js";
import { simplifyByStride, sumDistanceKm } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { selectAllPointsForEvent, upsertParticipantTrack } from "../queries/result.queries.js";

/**
 * Points kept per saved ride line. Much higher than a route preview (300) because this one IS
 * the history — there is no fuller copy to fall back to once the raw points are purged, so it
 * has to stand on its own. A 100 km ride at this density is a point roughly every 50 m.
 */
export const TRACK_POINT_TARGET = 2000;

/**
 * Safe to call again: the upsert is keyed on (event_id, participant_id), which matters
 * because an event finished twice — a retried request, or a status corrected and re-applied —
 * must neither double-write nor fail.
 *
 * Never throws into the caller. Finishing a ride is the organizer's action and has to succeed
 * even if this fails; a failure is loud in the log, and the tracks can still be rebuilt from
 * the raw points right up until those are purged.
 */
export async function writeParticipantTracks(eventId: string): Promise<number> {
  try {
    const points = await selectAllPointsForEvent(eventId);
    if (points.length === 0) {
      logger.info({ eventId }, "finish: no location points to save as tracks");
      return 0;
    }

    // The query orders by participant, then time, so a single pass groups them.
    const byParticipant = new Map<number, typeof points>();
    for (const point of points) {
      const existing = byParticipant.get(point.participant_id);
      if (existing) existing.push(point);
      else byParticipant.set(point.participant_id, [point]);
    }

    for (const [participantId, riderPoints] of byParticipant) {
      const latLngs: TrackPoint[] = riderPoints.map((p) => ({ lat: p.lat, lng: p.lng }));
      await upsertParticipantTrack({
        eventId,
        participantId,
        points: simplifyByStride(latLngs, TRACK_POINT_TARGET),
        // Count and distance describe what the rider ACTUALLY did — computed from every raw
        // point, before simplification. Only the drawn line is reduced.
        pointCount: riderPoints.length,
        distanceKm: sumDistanceKm(latLngs),
        startedAt: riderPoints[0].recorded_at,
        endedAt: riderPoints[riderPoints.length - 1].recorded_at,
        hadEmergency: riderPoints.some((p) => p.emergency),
      });
    }

    logger.info({ eventId, riders: byParticipant.size }, "finish: participant tracks saved");
    return byParticipant.size;
  } catch (err) {
    logger.error(
      { err, eventId },
      "finish: FAILED to save participant tracks — they can still be rebuilt from " +
        "location_points, but only until those are purged",
    );
    return 0;
  }
}
