// SQL for the saved ride lines (participant_tracks) and the raw points they are built from.
//
// participant_tracks is the ONE table in this schema that is never purged
// (sql/005-tracking.sql). location_points is the opposite: high volume, purge-eligible, and
// the only source the tracks can be built from — which is why writeParticipantTracks runs on
// the live -> finished transition and not later.

import { execute, query, queryOne } from "../../db/pool.js";
import type { ParticipantTrack, TrackPoint } from "../../db/types.js";

interface ParticipantTrackRow {
  id: number;
  event_id: string;
  participant_id: number;
  points: TrackPoint[] | null;
  point_count: number | null;
  distance_km: number | null;
  started_at: Date | null;
  ended_at: Date | null;
  had_emergency: boolean;
  created_at: Date;
}

function mapTrack(row: ParticipantTrackRow): ParticipantTrack {
  return {
    id: row.id,
    eventId: row.event_id,
    participantId: row.participant_id,
    points: row.points,
    pointCount: row.point_count,
    distanceKm: row.distance_km,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    hadEmergency: row.had_emergency,
    createdAt: row.created_at,
  };
}

export interface RawPointRow {
  participant_id: number;
  lat: number;
  lng: number;
  recorded_at: Date;
  emergency: boolean;
}

/**
 * Every raw point of one event, oldest first, grouped by rider in the caller. Read once, at
 * finish — this is the only query in the codebase that scans location_points across a whole
 * event, and it exists so that scan happens exactly once per ride instead of on every view.
 */
export async function selectAllPointsForEvent(eventId: string): Promise<RawPointRow[]> {
  return query<RawPointRow>(
    `SELECT lp.participant_id, lp.lat, lp.lng, lp.recorded_at, lp.emergency
       FROM location_points lp
       JOIN event_participants ep ON ep.id = lp.participant_id
      WHERE ep.event_id = $1
      ORDER BY lp.participant_id, lp.recorded_at ASC`,
    [eventId],
  );
}

export interface InsertTrackInput {
  eventId: string;
  participantId: number;
  points: TrackPoint[];
  pointCount: number;
  distanceKm: number;
  startedAt: Date | null;
  endedAt: Date | null;
  hadEmergency: boolean;
}

/**
 * Idempotent on (event_id, participant_id) — sql/005-tracking.sql has a unique index on the
 * pair. Finishing an event twice (a retried request, a status corrected and re-applied) must
 * not double-write, and must not fail either.
 */
export async function upsertParticipantTrack(input: InsertTrackInput): Promise<void> {
  await execute(
    `INSERT INTO participant_tracks
        (event_id, participant_id, points, point_count, distance_km, started_at, ended_at, had_emergency)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id, participant_id) DO UPDATE
        SET points = EXCLUDED.points,
            point_count = EXCLUDED.point_count,
            distance_km = EXCLUDED.distance_km,
            started_at = EXCLUDED.started_at,
            ended_at = EXCLUDED.ended_at,
            had_emergency = EXCLUDED.had_emergency`,
    [
      input.eventId,
      input.participantId,
      JSON.stringify(input.points),
      input.pointCount,
      input.distanceKm,
      input.startedAt,
      input.endedAt,
      input.hadEmergency,
    ],
  );
}

export async function selectTracksForEvent(eventId: string): Promise<ParticipantTrack[]> {
  const rows = await query<ParticipantTrackRow>(
    "SELECT * FROM participant_tracks WHERE event_id = $1 ORDER BY participant_id ASC",
    [eventId],
  );
  return rows.map(mapTrack);
}

export async function selectTrackForParticipant(
  eventId: string,
  participantId: number,
): Promise<ParticipantTrack | null> {
  const row = await queryOne<ParticipantTrackRow>(
    "SELECT * FROM participant_tracks WHERE event_id = $1 AND participant_id = $2",
    [eventId, participantId],
  );
  return row ? mapTrack(row) : null;
}

/** How far each rider got, for the results rows. Keyed by participant id. */
export async function selectDistancesForEvent(eventId: string): Promise<Map<number, number>> {
  const rows = await query<{ participant_id: number; distance_km: number | null }>(
    `SELECT participant_id, distance_travelled_km AS distance_km
       FROM participant_last_location
      WHERE event_id = $1`,
    [eventId],
  );
  const byParticipant = new Map<number, number>();
  for (const row of rows) {
    if (row.distance_km !== null) byParticipant.set(row.participant_id, row.distance_km);
  }
  return byParticipant;
}
