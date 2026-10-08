// SQL for Event Completion Medals (sql/061-event-medals.sql). The medal CONFIG lives on events
// (medal_enabled / medal_text, written by event.queries.ts updateEventMedalConfig); everything
// here is the AWARD history in event_medal_awards.

import { execute, query, queryOne } from "../db/pool.js";
import { checkinRuleSql } from "../statistics/statistics.queries.js";

export interface MedalAward {
  id: number;
  eventId: string;
  eventTitle: string;
  eventDate: Date;
  medalText: string;
  medalColorId: string | null;
  medalStyleId: string | null;
  awardedAt: Date;
  seenAt: Date | null;
}

interface MedalAwardRow {
  id: string | number;
  event_id: string;
  event_title: string;
  event_date: Date;
  medal_text: string;
  medal_color_id: string | null;
  medal_style_id: string | null;
  awarded_at: Date;
  seen_at: Date | null;
}

function mapAward(row: MedalAwardRow): MedalAward {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    eventTitle: row.event_title,
    eventDate: row.event_date,
    medalText: row.medal_text,
    medalColorId: row.medal_color_id ?? null,
    medalStyleId: row.medal_style_id ?? null,
    awardedAt: row.awarded_at,
    seenAt: row.seen_at,
  };
}

/**
 * Award the ride's medal to every rider who rode it, in ONE statement. Returns how many medals
 * were newly created (0 on a re-run).
 *
 * WHO: exactly the Statistics rule (statistics.queries.ts selectFinishedRideFactsForUser) — on
 * the start list (registered/approved), never left, has an account — plus the check-in rule when
 * `requireCheckinFrom` is set. Viewing a ride creates no participant row, so it never qualifies.
 *
 * THE RIDE MUST HAVE HAPPENED: it went live (started_at), or riders' GPS reached the server, or
 * this rider was checked in. A ride the sweeper closed that nobody ever rode
 * (event.service.ts isUnriddenAutoFinished — its organizer may still reopen it with a new date)
 * awards nothing.
 *
 * IDEMPOTENT: ON CONFLICT on uq_event_medal_awards_event_user — retries, overlapping sweeps and
 * several nodes can all run this and each rider still holds one medal. The snapshot columns
 * (title, date, dedication) are copied once and never rewritten.
 */
export async function insertMedalAwardsForEvent(
  eventId: string,
  requireCheckinFrom: Date | null,
): Promise<number> {
  const params: unknown[] = [eventId];
  let checkin = "";
  if (requireCheckinFrom) {
    params.push(requireCheckinFrom);
    checkin = `\n       AND ${checkinRuleSql(params.length)}`;
  }
  return execute(
    `INSERT INTO event_medal_awards
            (event_id, user_id, event_title, event_date, medal_text, medal_color_id, medal_style_id)
     SELECT e.id, ep.user_id, e.name, COALESCE(e.starts_at, e.finished_at), btrim(e.medal_text),
            e.medal_color_id, e.medal_style_id
       FROM events e
       JOIN event_participants ep ON ep.event_id = e.id
      WHERE e.id = $1
        AND e.status = 'finished'
        AND e.medal_enabled = TRUE
        AND COALESCE(btrim(e.medal_text), '') <> ''
        AND COALESCE(e.starts_at, e.finished_at) IS NOT NULL
        AND ep.user_id IS NOT NULL
        AND ep.registration_status IN ('registered', 'approved')
        AND ep.left_at IS NULL
        AND (e.started_at IS NOT NULL
             OR ep.attendance_status IN ('present', 'started')
             OR EXISTS (SELECT 1 FROM participant_tracks pt WHERE pt.event_id = e.id)
             OR EXISTS (SELECT 1 FROM location_points lp
                          JOIN event_participants lep ON lep.id = lp.participant_id
                         WHERE lep.event_id = e.id))${checkin}
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    params,
  );
}

/** Rides with the medal on that finished recently — the sweeper's catch-up re-runs their award
 *  (a no-op for medals already given) so a failed finish-hook award heals itself. */
export async function selectRecentlyFinishedMedalEventIds(
  withinDays: number,
  limit: number,
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM events
      WHERE status = 'finished' AND medal_enabled = TRUE
        AND finished_at >= NOW() - make_interval(days => $1)
      ORDER BY finished_at DESC
      LIMIT $2`,
    [withinDays, limit],
  );
  return rows.map((row) => row.id);
}

/** One page of the caller's medals, newest first. Keyset on (awarded_at, id) so a medal awarded
 *  while the rider scrolls never shifts or repeats a page. Served by idx_event_medal_awards_user_newest. */
export async function selectMedalsForUser(
  userId: number,
  limit: number,
  before: { awardedAt: Date; id: number } | null,
): Promise<MedalAward[]> {
  const params: unknown[] = [userId, limit];
  let cursor = "";
  if (before) {
    params.push(before.awardedAt, before.id);
    cursor = "\n        AND (awarded_at, id) < ($3, $4)";
  }
  const rows = await query<MedalAwardRow>(
    `SELECT id, event_id, event_title, event_date, medal_text, medal_color_id, medal_style_id,
            awarded_at, seen_at
       FROM event_medal_awards
      WHERE user_id = $1${cursor}
      ORDER BY awarded_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return rows.map(mapAward);
}

/** How many medals this rider holds and how many are still unseen. */
export async function selectMedalCounts(
  userId: number,
): Promise<{ total: number; unseen: number }> {
  const row = await queryOne<{ total: string | number; unseen: string | number }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE seen_at IS NULL) AS unseen
       FROM event_medal_awards WHERE user_id = $1`,
    [userId],
  );
  return { total: Number(row?.total ?? 0), unseen: Number(row?.unseen ?? 0) };
}

/** Unseen count only — served by the partial index idx_event_medal_awards_user_unseen. */
export async function countUnseenMedals(userId: number): Promise<number> {
  const row = await queryOne<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM event_medal_awards WHERE user_id = $1 AND seen_at IS NULL",
    [userId],
  );
  return Number(row?.n ?? 0);
}

/** Marks the CALLER's medals seen — the listed rides only, or all of them when `eventIds` is
 *  null. Another rider's rows can never match: user_id is always the authenticated caller. */
export async function markMedalsSeen(userId: number, eventIds: string[] | null): Promise<number> {
  if (eventIds) {
    return execute(
      `UPDATE event_medal_awards SET seen_at = NOW()
        WHERE user_id = $1 AND seen_at IS NULL AND event_id::text = ANY($2::text[])`,
      [userId, eventIds],
    );
  }
  return execute(
    "UPDATE event_medal_awards SET seen_at = NOW() WHERE user_id = $1 AND seen_at IS NULL",
    [userId],
  );
}

/** Which of these rides the caller holds a medal for — one query for a whole ride list. */
export async function selectMedalEventIdsForUser(
  userId: number,
  eventIds: string[],
): Promise<string[]> {
  const rows = await query<{ event_id: string }>(
    `SELECT event_id FROM event_medal_awards
      WHERE user_id = $1 AND event_id::text = ANY($2::text[])`,
    [userId, eventIds],
  );
  return rows.map((row) => String(row.event_id));
}
