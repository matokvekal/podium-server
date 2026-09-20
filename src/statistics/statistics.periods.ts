// Rider Statistics — calendar-period arithmetic and the cache-finality rule. Pure (no I/O) so the
// rules that decide "recompute or trust the cache" are unit-testable on their own.
//
// EVERYTHING IS UTC. A ride belongs to the UTC month/year of events.finished_at, the same clock
// statistics.queries.ts extracts with (`AT TIME ZONE 'UTC'`). One clock for the database and the
// service is what keeps a ride from being counted in one month and cached under another.

import type { PeriodType } from "./statistics.queries.js";

/** How long a CURRENT (still-open) month or year is trusted before it is rebuilt from the raw
 *  tables. A finishing ride rebuilds it immediately regardless — this is only the fallback. */
export const CURRENT_PERIOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a period's last instant it can STILL gain a ride. The auto-finish sweeper closes
 * a ride 24h after it ended (autoFinish.service.ts) and stamps finished_at with the ride's own
 * end time, so a ride that ended at 23:00 on the last day of a month is written into that month
 * ~24h into the next one. 26h = that 24h grace + slack for the 10-minute sweep interval. Only
 * after this is a closed period truly settled.
 */
export const PERIOD_SETTLE_MS = 26 * 60 * 60 * 1000;

/** A hard cap on how many periods one timeline call returns, so a corrupt lower bound can never
 *  ask for thousands of rows. 20 years of months. */
export const MAX_TIMELINE_PERIODS = 240;

const PERIOD_RE = { month: /^(\d{4})-(0[1-9]|1[0-2])$/, year: /^(\d{4})$/ } as const;

export function isValidPeriod(type: PeriodType, period: string): boolean {
  return PERIOD_RE[type].test(period);
}

export function periodOf(type: PeriodType, date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return type === "year" ? year : `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The first instant AFTER the period — when it stops being able to change. */
export function periodEnd(type: PeriodType, period: string): Date {
  if (type === "year") return new Date(Date.UTC(Number(period) + 1, 0, 1));
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)); // month is 1-based here, so this is the NEXT month
}

/** The period one step older. */
export function previousPeriod(type: PeriodType, period: string): string {
  if (type === "year") return String(Number(period) - 1).padStart(4, "0");
  const [year, month] = period.split("-").map(Number);
  return periodOf(type, new Date(Date.UTC(year, month - 2, 1)));
}

/** The period one step newer. */
export function nextPeriod(type: PeriodType, period: string): string {
  return periodOf(type, periodEnd(type, period));
}

/** Newest-first, contiguous list of periods from `oldest` up to and including `newest`. */
export function periodsBetween(type: PeriodType, oldest: string, newest: string): string[] {
  const out: string[] = [];
  let cursor = newest;
  while (cursor >= oldest && out.length < MAX_TIMELINE_PERIODS) {
    out.push(cursor);
    cursor = previousPeriod(type, cursor);
  }
  return out;
}

/** The instant from which a period can no longer change — its end plus PERIOD_SETTLE_MS. */
export function periodSettledAt(type: PeriodType, period: string): Date {
  return new Date(periodEnd(type, period).getTime() + PERIOD_SETTLE_MS);
}

/**
 * Can this cached row be served as-is?
 *
 *  - a period that is not SETTLED yet (still open, or closed within the last PERIOD_SETTLE_MS) is
 *    live: trusted for CURRENT_PERIOD_MAX_AGE_MS
 *  - a settled period is final once the row was computed on/after the settle instant — it can
 *    never change again. A row computed BEFORE that is stale and is rebuilt once.
 */
export function isPeriodCacheUsable(
  type: PeriodType,
  period: string,
  computedAt: Date,
  now: Date = new Date(),
): boolean {
  const settledAt = periodSettledAt(type, period);
  if (now.getTime() < settledAt.getTime()) {
    return now.getTime() - computedAt.getTime() < CURRENT_PERIOD_MAX_AGE_MS;
  }
  return computedAt.getTime() >= settledAt.getTime();
}

/** True once the period is SETTLED and its cached row was computed after that — what the client
 *  may keep forever. */
export function isPeriodFinal(
  type: PeriodType,
  period: string,
  computedAt: Date,
  now: Date = new Date(),
): boolean {
  const settledAt = periodSettledAt(type, period);
  return now.getTime() >= settledAt.getTime() && computedAt.getTime() >= settledAt.getTime();
}
