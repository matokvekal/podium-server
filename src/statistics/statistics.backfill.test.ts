// The history backfill's promises: same numbers as live, dry-run writes nothing, re-runs change
// nothing, one bad rider never blocks the rest, excluded accounts are never touched. The queries
// layer is replaced by an in-memory store (so a second run really sees what the first wrote) —
// the SQL itself is exercised against a real Postgres separately, see the header of
// statistics.backfill.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CachedRiderStats,
  FinishedRideFacts,
  RiderStatsTotals,
} from "./statistics.queries.js";

const NOW = new Date("2026-05-15T12:00:00Z");

const selectFinishedRideFactsForUser = vi.fn();
const selectBackfillCandidates = vi.fn();
const selectParticipationBreakdown = vi.fn();
const selectUserById = vi.fn();
const isAppFlagOn = vi.fn();
const getAppFlag = vi.fn();
const withTransaction = vi.fn();

// In-memory rider_period_stats / rider_stats_cache.
const periodRows = new Map<string, CachedRiderStats>();
const cacheRows = new Map<string, CachedRiderStats>();
const periodKey = (u: number, t: string, p: string) => `${u}|${t}|${p}`;

const upsertPeriodStatsBatch = vi.fn(
  async (userId: number, type: string, rows: { period: string; totals: RiderStatsTotals }[]) => {
    for (const row of rows) {
      periodRows.set(periodKey(userId, type, row.period), { ...row.totals, computedAt: NOW });
    }
  },
);
const upsertStatsCache = vi.fn(
  async (userId: number, year: number, _c: unknown, totals: RiderStatsTotals) => {
    cacheRows.set(`${userId}|${year}`, { ...totals, computedAt: NOW });
  },
);
const upsertPeriodStats = vi.fn();

vi.mock("../db/pool.js", () => ({
  withTransaction: (fn: (tx: unknown) => Promise<unknown>) => withTransaction(fn),
}));
vi.mock("../queries/event.queries.js", () => ({
  AUTO_FINISHABLE_STATUSES: ["published", "registration_open", "ready", "live"],
}));
vi.mock("../services/autoFinish.service.js", () => ({ AUTO_FINISH_GRACE_HOURS: 24 }));
vi.mock("../queries/appFlags.queries.js", () => ({
  isAppFlagOn: (...a: unknown[]) => isAppFlagOn(...a),
  getAppFlag: (...a: unknown[]) => getAppFlag(...a),
}));
vi.mock("../queries/user.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/user.queries.js")>(
    "../queries/user.queries.js",
  );
  return { ...actual, selectUserById: (...a: unknown[]) => selectUserById(...a) };
});
vi.mock("./statistics.backfill.queries.js", () => ({
  selectBackfillCandidates: (...a: unknown[]) => selectBackfillCandidates(...a),
  selectParticipationBreakdown: (...a: unknown[]) => selectParticipationBreakdown(...a),
  selectStatsCacheRows: async (userId: number) =>
    new Map(
      [...cacheRows]
        .filter(([k]) => k.startsWith(`${userId}|`))
        .map(([k, v]) => [Number(k.split("|")[1]), v]),
    ),
  upsertPeriodStatsBatch: (...a: Parameters<typeof upsertPeriodStatsBatch>) =>
    upsertPeriodStatsBatch(...a),
}));
vi.mock("./statistics.queries.js", async () => {
  const actual =
    await vi.importActual<typeof import("./statistics.queries.js")>("./statistics.queries.js");
  return {
    ...actual,
    selectFinishedRideFactsForUser: (...a: unknown[]) => selectFinishedRideFactsForUser(...a),
    selectPeriodStats: async (userId: number, type: string, periods: string[]) =>
      new Map(
        periods.flatMap((p) => {
          const hit = periodRows.get(periodKey(userId, type, p));
          return hit ? [[p, hit] as const] : [];
        }),
      ),
    selectFirstRidePeriod: vi.fn(),
    upsertStatsCache: (...a: Parameters<typeof upsertStatsCache>) => upsertStatsCache(...a),
    upsertPeriodStats: (...a: unknown[]) => upsertPeriodStats(...a),
  };
});

const { runStatsBackfill } = await import("./statistics.backfill.js");
const { buildRiderHistory, getPeriodTimeline } = await import("./statistics.service.js");
const { formatBackfillReport } = await import("./statistics.backfill.report.js");

function ride(
  year: number,
  month: number,
  over: Partial<FinishedRideFacts> = {},
): FinishedRideFacts {
  return {
    eventId: `e-${year}-${month}-${Math.random()}`,
    year,
    month,
    distanceKm: 30,
    elevationM: 400,
    durationHours: 2,
    organizerDurationMin: null,
    level: "intermediate",
    ...over,
  };
}

function candidate(userId: number, over: Record<string, unknown> = {}) {
  return { userId, country: "IL", weightKg: 70, isActive: true, excluded: false, ...over };
}

/** facts keyed by user id, for the selectFinishedRideFactsForUser stub */
function factsByUser(map: Record<number, FinishedRideFacts[] | Error>) {
  selectFinishedRideFactsForUser.mockImplementation(async (userId: number) => {
    const value = map[userId] ?? [];
    if (value instanceof Error) throw value;
    return value;
  });
}

beforeEach(() => {
  periodRows.clear();
  cacheRows.clear();
  for (const fn of [
    selectFinishedRideFactsForUser,
    selectBackfillCandidates,
    selectParticipationBreakdown,
    selectUserById,
    isAppFlagOn,
    getAppFlag,
    withTransaction,
    upsertPeriodStatsBatch,
    upsertStatsCache,
    upsertPeriodStats,
  ]) {
    fn.mockClear();
  }
  isAppFlagOn.mockResolvedValue(false);
  getAppFlag.mockResolvedValue(null);
  withTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  selectParticipationBreakdown.mockResolvedValue([]);
  selectBackfillCandidates.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildRiderHistory (pure)", () => {
  it("is null for a rider with no counted rides", () => {
    expect(buildRiderHistory([], 70, NOW)).toBeNull();
  });

  it("emits every month from the first ride through now — empty months included — and every year", () => {
    const history = buildRiderHistory([ride(2025, 11), ride(2026, 2)], 70, NOW)!;
    expect(history.firstPeriod).toBe("2025-11");
    expect(history.months.map((m) => m.period)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    expect(history.months.find((m) => m.period === "2025-12")!.totals.ridesCount).toBe(0);
    expect(history.years.map((y) => y.period)).toEqual(["2025", "2026"]);
    expect(history.cacheYears.map((y) => y.year)).toEqual([2025, 2026]);
    expect(history.lifetime.ridesCount).toBe(2);
    expect(history.ridesOutsideMonthRows).toBe(0);
  });

  it("month totals add up to the year and to lifetime", () => {
    const history = buildRiderHistory([ride(2026, 1), ride(2026, 1), ride(2026, 3)], 70, NOW)!;
    const rides = history.months.reduce((n, m) => n + m.totals.ridesCount, 0);
    expect(rides).toBe(3);
    expect(history.years[0].totals.ridesCount).toBe(3);
    expect(history.lifetime.ridesCount).toBe(3);
  });

  it("reports a ride dated in the future instead of silently dropping it", () => {
    const history = buildRiderHistory([ride(2026, 1), ride(2027, 3)], 70, NOW)!;
    expect(history.ridesOutsideMonthRows).toBe(1);
    expect(history.lifetime.ridesCount).toBe(2);
  });

  it("leaves calories null (never a guess) when the rider has no weight", () => {
    const history = buildRiderHistory([ride(2026, 1)], null, NOW)!;
    expect(history.lifetime.totalCalories).toBeNull();
    expect(history.months[0].totals.totalCalories).toBeNull();
  });
});

describe("same numbers as the live system", () => {
  it("every backfilled month equals what the live timeline computes from the same facts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const facts = [
      ride(2026, 1, {
        distanceKm: 42.4,
        elevationM: 750,
        durationHours: null,
        organizerDurationMin: 200,
      }),
      ride(2026, 1, { distanceKm: 18, elevationM: 120, durationHours: 1.1 }),
      ride(2026, 4, { distanceKm: 63.3, elevationM: 1300, durationHours: null, level: "advanced" }),
    ];
    selectUserById.mockResolvedValue({ weightKg: 82, country: "IL" });
    selectFinishedRideFactsForUser.mockResolvedValue(facts);
    const { selectFirstRidePeriod } = await import("./statistics.queries.js");
    (selectFirstRidePeriod as ReturnType<typeof vi.fn>).mockResolvedValue("2026-01");

    const history = buildRiderHistory(facts, 82, NOW)!;
    const timeline = await getPeriodTimeline(1, "month");

    for (const entry of timeline.periods) {
      const built = history.months.find((m) => m.period === entry.period)!;
      expect(built, entry.period).toBeDefined();
      expect(entry.rides).toBe(built.totals.ridesCount);
      expect(entry.distanceKm).toBe(built.totals.totalKm);
      expect(entry.climbM).toBe(built.totals.totalClimbM);
      expect(entry.hours).toBe(built.totals.totalHours);
      expect(entry.calories).toBe(built.totals.totalCalories);
    }
    expect(timeline.periods.length).toBe(5); // Jan..May
  });
});

describe("runStatsBackfill — dry run", () => {
  it("writes nothing, and reports what it would write", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1), ride(2026, 3)] });

    const report = await runStatsBackfill({ now: NOW });

    expect(report.mode).toBe("dry-run");
    expect(withTransaction).not.toHaveBeenCalled();
    expect(upsertPeriodStatsBatch).not.toHaveBeenCalled();
    expect(upsertStatsCache).not.toHaveBeenCalled();
    expect(upsertPeriodStats).not.toHaveBeenCalled();
    expect(periodRows.size).toBe(0);

    expect(report.ridersFound).toBe(1);
    expect(report.ridersProcessed).toBe(1);
    expect(report.ridesConsidered).toBe(2);
    expect(report.months).toEqual({ create: 5, update: 0, unchanged: 0 }); // Jan..May
    expect(report.years).toEqual({ create: 1, update: 0, unchanged: 0 });
    expect(report.cacheRows).toEqual({ create: 2, update: 0, unchanged: 0 }); // lifetime + 2026
  });

  it("reports a row that already exists with different numbers as an update", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    periodRows.set(periodKey(1, "month", "2026-01"), {
      ridesCount: 99,
      totalKm: 1,
      totalClimbM: 1,
      totalHours: 1,
      totalCalories: 1,
      computedAt: NOW,
    });

    const report = await runStatsBackfill({ now: NOW });

    expect(report.months.update).toBe(1);
    expect(report.months.create).toBe(4);
  });
});

describe("runStatsBackfill — execute", () => {
  it("writes every planned row, once, in one transaction per rider", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1), candidate(2)]);
    factsByUser({ 1: [ride(2026, 1)], 2: [ride(2025, 12), ride(2026, 5)] });

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.mode).toBe("execute");
    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(periodRows.has(periodKey(1, "month", "2026-01"))).toBe(true);
    expect(periodRows.has(periodKey(1, "year", "2026"))).toBe(true);
    expect(periodRows.has(periodKey(2, "month", "2025-12"))).toBe(true);
    expect(periodRows.has(periodKey(2, "year", "2025"))).toBe(true);
    expect(cacheRows.has("2|0")).toBe(true); // lifetime
    expect(cacheRows.has("2|2025")).toBe(true);
    expect(report.ridersProcessed).toBe(2);
    expect(report.months.create).toBe(5 + 6); // rider 1: Jan-May, rider 2: Dec-May
  });

  it("is idempotent: a second run finds nothing to create or change and writes no rows", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1), ride(2026, 3)] });

    await runStatsBackfill({ execute: true, now: NOW });
    const rowsAfterFirst = new Map(periodRows);
    upsertPeriodStatsBatch.mockClear();
    upsertStatsCache.mockClear();

    const second = await runStatsBackfill({ execute: true, now: NOW });

    expect(second.months).toEqual({ create: 0, update: 0, unchanged: 5 });
    expect(second.years).toEqual({ create: 0, update: 0, unchanged: 1 });
    expect(second.cacheRows).toEqual({ create: 0, update: 0, unchanged: 2 });
    expect(upsertStatsCache).not.toHaveBeenCalled();
    // Nothing duplicated: the same keys, the same values.
    expect(periodRows.size).toBe(rowsAfterFirst.size);
    expect([...periodRows]).toEqual([...rowsAfterFirst]);
  });

  it("re-runs an existing row when its numbers changed (a ride was added since)", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    await runStatsBackfill({ execute: true, now: NOW });

    factsByUser({ 1: [ride(2026, 1), ride(2026, 1)] });
    const second = await runStatsBackfill({ execute: true, now: NOW });

    expect(second.months.update).toBe(1);
    expect(periodRows.get(periodKey(1, "month", "2026-01"))!.ridesCount).toBe(2);
  });

  it("--only-missing never overwrites an existing row", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    const stale = {
      ridesCount: 99,
      totalKm: 1,
      totalClimbM: 1,
      totalHours: 1,
      totalCalories: 1,
      computedAt: NOW,
    };
    periodRows.set(periodKey(1, "month", "2026-01"), stale);

    const report = await runStatsBackfill({ execute: true, onlyMissing: true, now: NOW });

    expect(periodRows.get(periodKey(1, "month", "2026-01"))).toBe(stale);
    expect(report.months.unchanged).toBe(1);
    expect(report.months.create).toBe(4);
  });

  it("never touches an excluded account, and lists it", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1, { excluded: true }), candidate(2)]);
    factsByUser({ 1: [ride(2026, 1)], 2: [ride(2026, 1)] });

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.ridersFound).toBe(2);
    expect(report.ridersExcluded).toEqual({ count: 1, userIds: [1] });
    expect(report.ridersProcessed).toBe(1);
    expect(selectFinishedRideFactsForUser).not.toHaveBeenCalledWith(1, expect.anything());
    expect([...periodRows.keys()].some((k) => k.startsWith("1|"))).toBe(false);
    expect([...cacheRows.keys()].some((k) => k.startsWith("1|"))).toBe(false);
  });

  it("creates nothing for a rider none of whose rides count", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [] });

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.ridersWithoutCountedRides).toBe(1);
    expect(report.ridersProcessed).toBe(0);
    expect(periodRows.size).toBe(0);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("isolates a failing rider: the others are still written, the failure is reported", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1), candidate(2), candidate(3)]);
    factsByUser({ 1: [ride(2026, 1)], 2: new Error("boom"), 3: [ride(2026, 2)] });

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.failures).toEqual([{ userId: 2, error: "boom" }]);
    expect(report.ridersProcessed).toBe(2);
    expect(periodRows.has(periodKey(1, "month", "2026-01"))).toBe(true);
    expect(periodRows.has(periodKey(3, "month", "2026-02"))).toBe(true);
    expect([...periodRows.keys()].some((k) => k.startsWith("2|"))).toBe(false);
    expect(report.lastUserId).toBe(3);
  });

  it("a rider whose transaction fails is not counted as written", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    withTransaction.mockRejectedValueOnce(new Error("deadlock"));

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.ridersProcessed).toBe(0);
    expect(report.months.create).toBe(0);
    expect(report.failures).toHaveLength(1);
  });

  it("stops after 10 consecutive failures and says where to resume", async () => {
    const many = Array.from({ length: 15 }, (_, i) => candidate(i + 1));
    selectBackfillCandidates.mockResolvedValue(many);
    selectFinishedRideFactsForUser.mockRejectedValue(new Error("db down"));

    const report = await runStatsBackfill({ execute: true, now: NOW });

    expect(report.aborted).toBe(true);
    expect(report.failures).toHaveLength(10);
    expect(report.warnings.join(" ")).toContain("afterUserId=");
  });
});

describe("runStatsBackfill — check-in rule and history", () => {
  it("passes the SAME facts options as live: historical rides are not made to need check-in", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });

    // Switch on, but no rollout instant: nothing must be dropped.
    isAppFlagOn.mockResolvedValue(true);
    getAppFlag.mockResolvedValue("");
    const noCutoff = await runStatsBackfill({ now: NOW });
    expect(selectFinishedRideFactsForUser).toHaveBeenLastCalledWith(1, {
      requireCheckinFrom: null,
    });
    expect(noCutoff.checkInRequiredFrom).toBeNull();

    // Switch on WITH a rollout instant: the rule is handed to the facts query, which applies it
    // only to rides that started on/after that instant (checkinRuleSql).
    getAppFlag.mockResolvedValue("2026-04-01T00:00:00Z");
    const withCutoff = await runStatsBackfill({ now: NOW });
    expect(selectFinishedRideFactsForUser).toHaveBeenLastCalledWith(1, {
      requireCheckinFrom: new Date("2026-04-01T00:00:00Z"),
    });
    expect(withCutoff.checkInRequiredFrom).toBe("2026-04-01T00:00:00.000Z");
  });

  it("hands the resume filter to the candidate query and reports the last rider reached", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(11), candidate(12)]);
    factsByUser({ 11: [ride(2026, 1)], 12: [ride(2026, 1)] });

    const report = await runStatsBackfill({ now: NOW, filter: { afterUserId: 10, limit: 2 } });

    expect(selectBackfillCandidates).toHaveBeenCalledWith({ afterUserId: 10, limit: 2 });
    expect(report.lastUserId).toBe(12);
  });
});

describe("runStatsBackfill — ignored rides and the cross-check", () => {
  it("lists why participations were not counted", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    selectParticipationBreakdown.mockResolvedValue([
      { reason: "counted", participations: 1 },
      { reason: "guest_participant_no_account", participations: 7 },
      { reason: "ride_past_due_awaiting_auto_finish", participations: 3 },
    ]);

    const report = await runStatsBackfill({ now: NOW });

    expect(report.ignored).toEqual([
      { reason: "guest_participant_no_account", participations: 7 },
      { reason: "ride_past_due_awaiting_auto_finish", participations: 3 },
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("warns when the breakdown and the facts disagree about how many rides count", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    selectParticipationBreakdown.mockResolvedValue([{ reason: "counted", participations: 4 }]);

    const report = await runStatsBackfill({ now: NOW });

    expect(report.warnings[0]).toContain("cross-check");
  });

  it("skips the cross-check on a --limit chunk (the breakdown covers every rider)", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1)]);
    factsByUser({ 1: [ride(2026, 1)] });
    selectParticipationBreakdown.mockResolvedValue([{ reason: "counted", participations: 40 }]);

    const report = await runStatsBackfill({ now: NOW, filter: { limit: 1 } });

    expect(report.warnings).toEqual([]);
  });
});

describe("formatBackfillReport", () => {
  it("names the mode, the counts and the reasons", async () => {
    selectBackfillCandidates.mockResolvedValue([candidate(1, { excluded: true }), candidate(2)]);
    factsByUser({ 2: [ride(2026, 1)] });
    selectParticipationBreakdown.mockResolvedValue([
      { reason: "counted", participations: 1 },
      { reason: "rider_left_the_ride", participations: 2 },
    ]);

    const text = formatBackfillReport(await runStatsBackfill({ now: NOW }));

    expect(text).toContain("DRY RUN (nothing written)");
    expect(text).toContain("riders excluded          1  (ids: 1)");
    expect(text).toContain("monthly statistics");
    expect(text).toContain("rider_left_the_ride");
  });
});
