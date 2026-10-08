// EVENT COMPLETION MEDALS (sql/061-event-medals.sql).
//
// An organizer may switch a medal on for a ride and write a dedication (≤30 words). When the ride
// finishes, every rider who rode it gets ONE permanent medal: a snapshot of the ride's name, date
// and the dedication, kept in event_medal_awards. Separate from the Statistics gems — those are
// recomputed totals; a medal is a fact about one ride that never changes afterwards.
//
// FAIL-SAFE BY CONSTRUCTION. A medal is decoration: nothing here may break finishing a ride, My
// Rides, the profile or Statistics. Every export below either never throws (the award, the list
// decoration, the unseen count) or is only reached from the medals' own endpoints. A database
// without sql/061 reads as "no medals" everywhere.
//
// WHERE AWARDS HAPPEN — server business logic only, never an endpoint:
//   1. the organizer's Finish (event.service.ts changeEventStatus, live -> finished);
//   2. the auto-finish sweeper (autoFinish.service.ts), after it flips a ride;
//   3. an organizer ticking a rider present after the finish (participant.service.ts setAttendance);
//   4. the sweeper's catch-up over recently finished medal rides (heals a failed 1-3).
// All four run the same idempotent INSERT ... ON CONFLICT DO NOTHING.

import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import {
  countUnseenMedals,
  insertMedalAwardsForEvent,
  markMedalsSeen,
  type MedalAward,
  selectMedalCounts,
  selectMedalEventIdsForUser,
  selectMedalsForUser,
  selectRecentlyFinishedMedalEventIds,
} from "../queries/eventMedals.queries.js";
import { resolveFactsOptions } from "../statistics/statistics.service.js";

/** Postgres undefined_table / undefined_column — sql/061 not applied yet. */
function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

function warnOnce(err: unknown, what: string, context: Record<string, unknown> = {}) {
  if (isMissingSchemaError(err)) {
    logger.warn({ ...context }, `${what}: event_medal_awards missing — run sql/061-event-medals.sql`);
  } else {
    logger.warn({ err, ...context }, `${what} failed`);
  }
}

/**
 * Give the ride's medal to every rider who rode it. Never throws; a ride with the medal off (or a
 * ride that is not finished) inserts nothing. Returns how many medals were newly awarded.
 */
export async function awardMedalsForFinishedEvent(eventId: string): Promise<number> {
  try {
    // The same check-in rule Statistics applies, read the same way (app_flags, safe default off).
    const { requireCheckinFrom } = await resolveFactsOptions();
    const awarded = await insertMedalAwardsForEvent(eventId, requireCheckinFrom ?? null);
    if (awarded > 0) logger.info({ eventId, awarded }, "completion medals awarded");
    return awarded;
  } catch (err) {
    warnOnce(err, "completion medals: award", { eventId });
    return 0;
  }
}

/** How far back the sweeper's catch-up looks, and how many rides it touches per tick. */
export const MEDAL_CATCH_UP_DAYS = 7;
const MEDAL_CATCH_UP_LIMIT = 50;

/** The sweeper's safety net: re-run the award for medal rides finished in the last week. A ride
 *  whose medals were all given inserts nothing. Never throws. */
export async function catchUpRecentMedalAwards(): Promise<number> {
  let ids: string[];
  try {
    ids = await selectRecentlyFinishedMedalEventIds(MEDAL_CATCH_UP_DAYS, MEDAL_CATCH_UP_LIMIT);
  } catch (err) {
    warnOnce(err, "completion medals: catch-up list");
    return 0;
  }
  let awarded = 0;
  for (const id of ids) awarded += await awardMedalsForFinishedEvent(id);
  return awarded;
}

/** Which of these rides the rider holds a medal for. Never throws: on failure, none. */
export async function selectMyMedalEventIds(
  userId: number,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  try {
    return new Set(await selectMedalEventIdsForUser(userId, eventIds));
  } catch (err) {
    warnOnce(err, "completion medals: my-rides decoration", { userId });
    return new Set();
  }
}

/** The profile's "new medal" count. Never throws: on failure, 0 (no dot, no reveal). */
export async function getUnseenMedalCount(userId: number): Promise<number> {
  try {
    return await countUnseenMedals(userId);
  } catch (err) {
    warnOnce(err, "completion medals: unseen count", { userId });
    return 0;
  }
}

// ---- GET /medals/me ----------------------------------------------------------------------------

export const MEDALS_PAGE_DEFAULT = 20;
export const MEDALS_PAGE_MAX = 50;

/** Opaque cursor: "<awardedAt ISO>_<id>" of the last medal on the previous page. */
export function encodeMedalCursor(medal: Pick<MedalAward, "awardedAt" | "id">): string {
  return `${medal.awardedAt.toISOString()}_${medal.id}`;
}

export function decodeMedalCursor(raw: string): { awardedAt: Date; id: number } {
  const sep = raw.lastIndexOf("_");
  const awardedAt = new Date(raw.slice(0, sep));
  const id = Number(raw.slice(sep + 1));
  if (sep < 1 || Number.isNaN(awardedAt.getTime()) || !Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "Invalid cursor");
  }
  return { awardedAt, id };
}

export interface MedalsPage {
  medals: MedalAward[];
  nextCursor: string | null;
  total: number;
  unseen: number;
}

/** One page of the caller's medals, newest first. A database without sql/061 is an empty
 *  collection, not an error — the Achievements page must render either way. */
export async function listMyMedals(
  userId: number,
  limit: number,
  before: string | undefined,
): Promise<MedalsPage> {
  const cursor = before ? decodeMedalCursor(before) : null;
  try {
    // One extra row tells whether another page exists without a COUNT per page.
    const rows = await selectMedalsForUser(userId, limit + 1, cursor);
    const medals = rows.slice(0, limit);
    const last = medals[medals.length - 1];
    const nextCursor = rows.length > limit && last ? encodeMedalCursor(last) : null;
    // Totals only on the first page — the header shows them; later pages don't need them again.
    const counts = cursor ? { total: -1, unseen: -1 } : await selectMedalCounts(userId);
    return { medals, nextCursor, ...counts };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      warnOnce(err, "completion medals: list", { userId });
      return { medals: [], nextCursor: null, total: 0, unseen: 0 };
    }
    throw err;
  }
}

/** Mark the caller's medals seen (the listed rides, or all). Idempotent. */
export async function markMyMedalsSeen(
  userId: number,
  eventIds: string[] | null,
): Promise<number> {
  try {
    return await markMedalsSeen(userId, eventIds);
  } catch (err) {
    if (isMissingSchemaError(err)) return 0;
    throw err;
  }
}
