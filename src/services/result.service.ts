// Reading a finished ride: who finished, in what order, how far, with the route — plus the
// saved ride lines.
//
// The WRITE half (the finish hook that produces those lines) lives in track-writer.ts, and
// the comment there explains why it is a separate file.

import type { Event, EventParticipant, ParticipantTrack } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { resolveImageUrl } from "../lib/user-images.js";
import { selectParticipantsForEvent } from "../queries/participant.queries.js";
import {
  selectDistancesForEvent,
  selectTrackForParticipant,
  selectTracksForEvent,
} from "../queries/result.queries.js";
import type { RouteWithOwner } from "../queries/routeLibrary.queries.js";
import { selectUserById } from "../queries/user.queries.js";
import { getEventForViewer, type ViewerTier } from "./event.service.js";
import { getEventRouteSummary } from "./eventRoute.service.js";

export type RiderStatus = "finished" | "dnf" | "dns" | "racing" | "not_started";

export interface SplitResult {
  splitId: string;
  time: string | null;
  gap: string | null;
  place: number | null;
}

export interface RiderResult {
  id: string;
  bib: string | null;
  name: string;
  avatarUrl: string | null;
  countryCode: string | null;
  category: string | null;
  team: string | null;
  status: RiderStatus;
  totalTime: string | null;
  gap: string | null;
  overallPlace: number | null;
  categoryPlace: number | null;
  distanceKm: number;
  splits: SplitResult[];
}

export interface EventOrganizerInfo {
  name: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface EventResults {
  organizer: EventOrganizerInfo;
  route: RouteWithOwner | null;
  riders: RiderResult[];
}

/**
 * Collapses the two independent status axes into the one label the results row shows.
 *
 * "stopped" maps to "dnf": the client's vocabulary has no separate word for it, and to a
 * reader of a results list they mean the same thing — did not complete. The distinction
 * survives in result_status for anyone who needs it.
 */
function toRiderStatus(participant: EventParticipant): RiderStatus {
  switch (participant.resultStatus) {
    case "finished":
      return "finished";
    case "dnf":
    case "stopped":
      return "dnf";
    default:
      break;
  }
  if (participant.attendanceStatus === "dns") return "dns";
  if (participant.attendanceStatus === "started") return "racing";
  return "not_started";
}

/** "1:23:45", or "23:45" under an hour. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "+2:07". The leader's own gap is null, not "+0:00" — they are not behind anyone. */
function formatGap(ms: number): string | null {
  if (ms <= 0) return null;
  return `+${formatElapsed(ms)}`;
}

/**
 * Place is computed here, never stored. A stored rank drifts the moment one finish time is
 * corrected, and correcting a time is the single most common thing an organizer does after
 * a ride. Same rule as computeEffectiveStatus.
 *
 * finish_position wins when the organizer set it by hand — they were standing at the line
 * and the clock was not. Otherwise finishers are ordered by finished_at.
 */
function rankFinishers(participants: EventParticipant[]): Map<number, number> {
  const finishers = participants.filter((p) => p.resultStatus === "finished");
  const ordered = [...finishers].sort((a, b) => {
    if (a.finishPosition !== null && b.finishPosition !== null)
      return a.finishPosition - b.finishPosition;
    // A hand-set position always outranks a bare timestamp.
    if (a.finishPosition !== null) return -1;
    if (b.finishPosition !== null) return 1;
    const at = a.finishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.finishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return at - bt;
  });

  const places = new Map<number, number>();
  ordered.forEach((p, index) => {
    places.set(p.id, index + 1);
  });
  return places;
}

/** Rank within each `category` value, in the same order the overall ranking used. */
function rankByCategory(
  participants: EventParticipant[],
  overall: Map<number, number>,
): Map<number, number> {
  const byCategory = new Map<string, EventParticipant[]>();
  for (const p of participants) {
    if (!overall.has(p.id) || p.category === null) continue;
    const list = byCategory.get(p.category);
    if (list) list.push(p);
    else byCategory.set(p.category, [p]);
  }

  const places = new Map<number, number>();
  for (const group of byCategory.values()) {
    group
      .sort((a, b) => (overall.get(a.id) ?? 0) - (overall.get(b.id) ?? 0))
      .forEach((p, index) => {
        places.set(p.id, index + 1);
      });
  }
  return places;
}

/**
 * Results are readable by the owner and by anyone riding it; a public event's results follow
 * `show_results`, and a rider still waiting on approval sees none of it — same tiering as the
 * event detail itself.
 */
function canViewResults(event: Event, tier: ViewerTier): boolean {
  if (tier === "owner" || tier === "approved") return true;
  if (tier === "pending") return false;
  return event.visibility === "public" && event.showResults;
}

export async function getEventResults(
  eventId: string,
  viewerId: number | null,
): Promise<EventResults> {
  const { event, tier } = await getEventForViewer(eventId, viewerId);
  if (!canViewResults(event, tier)) {
    throw new ApiError(403, "Results are not shared for this event");
  }

  const [participants, distances, route, owner] = await Promise.all([
    selectParticipantsForEvent(eventId),
    selectDistancesForEvent(eventId),
    getEventRouteSummary(eventId),
    event.ownerId === null ? Promise.resolve(null) : selectUserById(event.ownerId),
  ]);

  // Only riders who are actually on the start list belong in results — a rejected
  // registration is not a DNS, they were never in the ride.
  const racing = participants.filter(
    (p) => p.registrationStatus === "registered" || p.registrationStatus === "approved",
  );

  const overallPlaces = rankFinishers(racing);
  const categoryPlaces = rankByCategory(racing, overallPlaces);

  // Elapsed time runs from the event's start, not the rider's first GPS point: riders set off
  // together, and a rider whose phone started late would otherwise appear faster than they were.
  const startedAt = event.startsAt;
  const leaderFinish = racing
    .filter((p) => overallPlaces.get(p.id) === 1)
    .map((p) => p.finishedAt)
    .find((d): d is Date => d !== null);

  const riders: RiderResult[] = racing.map((p) => {
    const elapsedMs =
      startedAt && p.finishedAt ? p.finishedAt.getTime() - startedAt.getTime() : null;
    const gapMs =
      leaderFinish && p.finishedAt ? p.finishedAt.getTime() - leaderFinish.getTime() : null;
    return {
      id: String(p.id),
      bib: p.bib,
      name: p.name ?? "Rider",
      avatarUrl: p.avatarUrl,
      countryCode: p.countryCode,
      category: p.category,
      team: p.team,
      status: toRiderStatus(p),
      totalTime: elapsedMs === null ? null : formatElapsed(elapsedMs),
      gap: gapMs === null ? null : formatGap(gapMs),
      overallPlace: overallPlaces.get(p.id) ?? null,
      categoryPlace: categoryPlaces.get(p.id) ?? null,
      distanceKm: distances.get(p.id) ?? 0,
      // Races only — event_splits does not exist yet, so every rider has an empty list rather
      // than the field being absent. See plan/server-tasks.md Part A.
      splits: [],
    };
  });

  // Sorted the way the page reads: finishers in order, then everyone else by name.
  riders.sort((a, b) => {
    if (a.overallPlace !== null && b.overallPlace !== null) return a.overallPlace - b.overallPlace;
    if (a.overallPlace !== null) return -1;
    if (b.overallPlace !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    organizer: {
      name:
        [owner?.firstName, owner?.lastName].filter(Boolean).join(" ").trim() ||
        owner?.nickname ||
        null,
      // Effective avatar, same as everywhere else the organizer is shown — their upload,
      // else their chosen preset, else the Google picture (lib/user-images.ts).
      avatarUrl: owner
        ? resolveImageUrl("avatar", owner.avatarType, owner.avatarValue, owner.avatarUrl)
        : null,
      // No country is stored for a user yet. Null rather than a guess — see NOTES.md.
      countryCode: null,
    },
    route,
    riders,
  };
}

// ---- history tracks ---------------------------------------------------------------------

/**
 * The saved ride lines. Gated on `show_history_locations`, which is a stricter default than
 * results (FALSE, where show_results is TRUE): where someone rode is more revealing than
 * whether they finished — it is their route home.
 */
function canViewHistory(event: Event, tier: ViewerTier): boolean {
  if (tier === "owner") return true;
  if (tier === "pending") return false;
  return event.showHistoryLocations;
}

export async function getEventTracks(
  eventId: string,
  viewerId: number | null,
): Promise<ParticipantTrack[]> {
  const { event, tier } = await getEventForViewer(eventId, viewerId);
  if (!canViewHistory(event, tier)) {
    throw new ApiError(403, "Ride history is not shared for this event");
  }
  return selectTracksForEvent(eventId);
}

export async function getParticipantTrack(
  eventId: string,
  participantId: number,
  viewerId: number | null,
): Promise<ParticipantTrack> {
  const { event, tier } = await getEventForViewer(eventId, viewerId);

  // A rider may always see their own line, whatever the event says — the same rule the live
  // map follows for a rider's own position.
  const isMine =
    viewerId !== null &&
    (await selectParticipantsForEvent(eventId)).some(
      (p) => p.id === participantId && p.userId === viewerId,
    );
  if (!isMine && !canViewHistory(event, tier)) {
    throw new ApiError(403, "Ride history is not shared for this event");
  }

  const track = await selectTrackForParticipant(eventId, participantId);
  if (!track) throw new ApiError(404, "No saved track for this rider");
  return track;
}
