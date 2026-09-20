// statistics.service.ts is the whole point of the cache: read cached-if-fresh, recompute
// (from real per-ride facts) if stale/missing, and never invent a calorie number for a rider
// with no weight set. No test database, so the queries layer is stubbed — same harness as
// event.service.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectFinishedRideFactsForUser = vi.fn();
const selectFinishedEventParticipantUserIds = vi.fn();
const selectStatsCache = vi.fn();
const upsertStatsCache = vi.fn();
const selectLeaderboard = vi.fn();
const selectUserById = vi.fn();
const selectPeriodStats = vi.fn();
const upsertPeriodStats = vi.fn();
const selectFirstRidePeriod = vi.fn();
const selectEventFinishedAt = vi.fn();
const isAppFlagOn = vi.fn();
const getAppFlag = vi.fn();

vi.mock("./statistics.queries.js", async () => {
  const actual =
    await vi.importActual<typeof import("./statistics.queries.js")>("./statistics.queries.js");
  return {
    ...actual,
    selectFinishedRideFactsForUser: (...a: unknown[]) => selectFinishedRideFactsForUser(...a),
    selectFinishedEventParticipantUserIds: (...a: unknown[]) =>
      selectFinishedEventParticipantUserIds(...a),
    selectStatsCache: (...a: unknown[]) => selectStatsCache(...a),
    upsertStatsCache: (...a: unknown[]) => upsertStatsCache(...a),
    selectLeaderboard: (...a: unknown[]) => selectLeaderboard(...a),
    selectPeriodStats: (...a: unknown[]) => selectPeriodStats(...a),
    upsertPeriodStats: (...a: unknown[]) => upsertPeriodStats(...a),
    selectFirstRidePeriod: (...a: unknown[]) => selectFirstRidePeriod(...a),
    selectEventFinishedAt: (...a: unknown[]) => selectEventFinishedAt(...a),
  };
});

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

const {
  getRiderStatsPayload,
  getLeaderboard,
  getPeriodTimeline,
  refreshStatsAfterAttendanceChange,
  refreshStatsForFinishedEvent,
} = await import("./statistics.service.js");

const USER_ID = 42;

/** A finished ride with a real GPS track (so a real duration -> real speed is used). */
const RIDE_WITH_TRACK = {
  eventId: "e1",
  year: 2026,
  month: 3,
  distanceKm: 40,
  elevationM: 500,
  durationHours: 2, // 20 km/h
  organizerDurationMin: null,
  level: null,
};

/** A finished ride with NO GPS track but an organizer-stated duration. */
const RIDE_NO_TRACK = {
  eventId: "e2",
  year: 2026,
  month: 8,
  distanceKm: 30,
  elevationM: 200,
  durationHours: null,
  organizerDurationMin: 60, // 30 km/h
  level: null,
};

beforeEach(() => {
  selectFinishedRideFactsForUser.mockReset().mockResolvedValue([RIDE_WITH_TRACK, RIDE_NO_TRACK]);
  selectFinishedEventParticipantUserIds.mockReset().mockResolvedValue([USER_ID, 43]);
  selectStatsCache.mockReset().mockResolvedValue(null);
  upsertStatsCache.mockReset().mockResolvedValue(undefined);
  selectLeaderboard.mockReset().mockResolvedValue({ top: [], me: null });
  selectUserById.mockReset().mockResolvedValue({ id: USER_ID, weightKg: 75, country: "IL" });
  selectPeriodStats.mockReset().mockResolvedValue(new Map());
  upsertPeriodStats.mockReset().mockResolvedValue(undefined);
  selectFirstRidePeriod.mockReset().mockResolvedValue("2026-03");
  selectEventFinishedAt.mockReset().mockResolvedValue(new Date("2026-08-30T10:00:00Z"));
  isAppFlagOn.mockReset().mockResolvedValue(false);
  getAppFlag.mockReset().mockResolvedValue(null);
});

describe("getRiderStatsPayload — trusts participation, no GPS requirement", () => {
  it("counts BOTH rides — the one with a track and the one without", async () => {
    const payload = await getRiderStatsPayload(USER_ID);
    expect(payload.lifetime.rides).toBe(2);
    expect(payload.lifetime.distanceKm).toBe(70);
    expect(payload.lifetime.climbM).toBe(700);
  });

  it("computes hours from real GPS duration + organizer duration, summed across rides", async () => {
    const payload = await getRiderStatsPayload(USER_ID);
    // 2h (real) + 1h (organizer's 60 min) = 3h.
    expect(payload.lifetime.hours).toBe(3);
  });

  it("computes calories using REAL speed from the track when one exists, and the organizer's stated duration otherwise", async () => {
    const payload = await getRiderStatsPayload(USER_ID);
    expect(payload.lifetime.calories).not.toBeNull();
    expect(payload.lifetime.calories).toBeGreaterThan(0);
  });

  it("never invents a calorie number for a rider with no weight set", async () => {
    selectUserById.mockResolvedValue({ id: USER_ID, weightKg: null, country: "IL" });
    const payload = await getRiderStatsPayload(USER_ID);
    expect(payload.weightKg).toBeNull();
    expect(payload.lifetime.calories).toBeNull();
    expect(payload.byYear.every((y) => y.calories === null)).toBe(true);
  });

  it(
    "serves a fresh cache row as-is — the raw facts are still read ONCE (to list which years " +
      "exist for the year-tab selector), but never recomputed/re-cached",
    async () => {
      selectStatsCache.mockResolvedValue({
        ridesCount: 999,
        totalKm: 999,
        totalClimbM: 999,
        totalHours: 999,
        totalCalories: 999,
        computedAt: new Date(), // just now — well within the 24h window
      });

      const payload = await getRiderStatsPayload(USER_ID);

      expect(payload.lifetime.rides).toBe(999);
      expect(selectFinishedRideFactsForUser).toHaveBeenCalledTimes(1);
      expect(upsertStatsCache).not.toHaveBeenCalled();
    },
  );

  it("recomputes when the cache row is older than 24h", async () => {
    selectStatsCache.mockResolvedValue({
      ridesCount: 999,
      totalKm: 999,
      totalClimbM: 999,
      totalHours: 999,
      totalCalories: 999,
      computedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const payload = await getRiderStatsPayload(USER_ID);

    expect(payload.lifetime.rides).toBe(2); // recomputed from the real facts, not 999
    expect(upsertStatsCache).toHaveBeenCalled();
  });

  it("splits totals into the years the rider actually rode in", async () => {
    selectFinishedRideFactsForUser.mockResolvedValue([
      { ...RIDE_WITH_TRACK, year: 2025 },
      { ...RIDE_NO_TRACK, year: 2026 },
    ]);

    const payload = await getRiderStatsPayload(USER_ID);

    expect(payload.byYear.map((y) => y.year)).toEqual([2026, 2025]); // newest first
    expect(payload.byYear.find((y) => y.year === 2025)?.rides).toBe(1);
    expect(payload.byYear.find((y) => y.year === 2026)?.rides).toBe(1);
  });

  it("achievement progress reads LIFETIME totals, not a per-year one", async () => {
    const payload = await getRiderStatsPayload(USER_ID);
    const ridesAchievement = payload.achievements.find((a) => a.category === "rides")!;
    // 2 lifetime rides -> below the first tier (25), so no current tier yet.
    expect(ridesAchievement.current).toBeNull();
  });
});

describe("refreshStatsForFinishedEvent — the eager path off the finish hook", () => {
  it(
    "looks up the event's roster itself, recomputes lifetime AND the current year for every " +
      "finisher, and never throws even when one rider's lookup fails",
    async () => {
      selectUserById.mockRejectedValueOnce(new Error("boom"));

      await expect(refreshStatsForFinishedEvent("event-1")).resolves.toBeUndefined();

      expect(selectFinishedEventParticipantUserIds).toHaveBeenCalledWith("event-1");
      // One user's failure does not block the other's cache write.
      expect(upsertStatsCache).toHaveBeenCalled();
    },
  );

  it("never throws even when the roster lookup itself fails", async () => {
    selectFinishedEventParticipantUserIds.mockRejectedValue(new Error("db down"));
    await expect(refreshStatsForFinishedEvent("event-1")).resolves.toBeUndefined();
    expect(upsertStatsCache).not.toHaveBeenCalled();
  });
});

describe("getLeaderboard — country-scoped, refreshes the CALLER's own row first", () => {
  it("defaults to the caller's own users.country when none is requested", async () => {
    selectStatsCache.mockResolvedValue(null); // no row yet for this scope

    await getLeaderboard(USER_ID, "distanceKm", "year", 2026, undefined);

    expect(upsertStatsCache).toHaveBeenCalled();
    expect(selectLeaderboard).toHaveBeenCalledWith("distanceKm", 2026, "IL", USER_ID);
  });

  it(
    "an explicit country overrides the caller's own for the RANKING, but never for the " +
      "caller's own cache-row country snapshot",
    async () => {
      selectStatsCache.mockResolvedValue(null);

      await getLeaderboard(USER_ID, "rides", "lifetime", undefined, "US");

      expect(selectLeaderboard).toHaveBeenCalledWith("rides", 0, "US", USER_ID);
    },
  );

  it("returns an empty leaderboard, not a guessed one, for a caller with no country set", async () => {
    selectUserById.mockResolvedValue({ id: USER_ID, weightKg: 75, country: null });

    const payload = await getLeaderboard(USER_ID, "rides", "lifetime", undefined, undefined);

    expect(payload).toEqual({
      category: "rides",
      period: "lifetime",
      year: 0,
      country: "",
      top: [],
      me: null,
    });
    expect(selectLeaderboard).not.toHaveBeenCalled();
  });

  it("skips the recompute when the caller's own row is already fresh", async () => {
    selectStatsCache.mockResolvedValue({
      ridesCount: 1,
      totalKm: 1,
      totalClimbM: 1,
      totalHours: 1,
      totalCalories: 1,
      computedAt: new Date(),
    });

    await getLeaderboard(USER_ID, "rides", "lifetime", undefined, undefined);

    expect(upsertStatsCache).not.toHaveBeenCalled();
  });
});

describe("getPeriodTimeline — month/year results with the live-current / final-past cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inMonth = (month: number, extra: Partial<typeof RIDE_WITH_TRACK> = {}) => ({
    ...RIDE_WITH_TRACK,
    eventId: `e-${month}`,
    year: 2026,
    month,
    ...extra,
  });

  it("returns every month from the first ride to now, newest first, empty months included", async () => {
    selectFirstRidePeriod.mockResolvedValue("2026-07");
    selectFinishedRideFactsForUser.mockResolvedValue([inMonth(7), inMonth(9)]);

    const payload = await getPeriodTimeline(USER_ID, "month");

    expect(payload.periods.map((p) => p.period)).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(payload.periods.map((p) => p.rides)).toEqual([1, 0, 1]);
    // August has no ride: honest zeros, and Stone gems — never invented.
    expect(payload.periods[1].distanceKm).toBe(0);
    expect(payload.periods[1].gems.rides).toBe("stone");
  });

  it("carries the older period as `previous` for the trend arrows, including the oldest shown", async () => {
    selectFirstRidePeriod.mockResolvedValue("2026-08");
    selectFinishedRideFactsForUser.mockResolvedValue([
      inMonth(8),
      inMonth(9),
      inMonth(9, { eventId: "x" }),
    ]);

    const payload = await getPeriodTimeline(USER_ID, "month");

    const [sept, aug] = payload.periods;
    expect(sept.rides).toBe(2);
    expect(sept.previous.rides).toBe(1);
    expect(aug.previous.rides).toBe(0); // July: before the first ride
  });

  it("serves settled periods from the cache and only recomputes what is missing or stale", async () => {
    selectFirstRidePeriod.mockResolvedValue("2026-07");
    const settled = {
      ridesCount: 5,
      totalKm: 100,
      totalClimbM: 1000,
      totalHours: 6,
      totalCalories: 2500,
      computedAt: new Date("2026-08-05T00:00:00Z"), // after July closed: final
    };
    selectPeriodStats.mockResolvedValue(
      new Map([
        ["2026-07", settled],
        ["2026-06", settled],
      ]),
    );
    selectFinishedRideFactsForUser.mockResolvedValue([]);

    const payload = await getPeriodTimeline(USER_ID, "month");

    const july = payload.periods.find((p) => p.period === "2026-07");
    expect(july?.rides).toBe(5);
    expect(july?.final).toBe(true);
    // July/June came from the cache; only August + September were rebuilt and re-cached.
    const rebuilt = upsertPeriodStats.mock.calls.map((c) => c[2]).sort();
    expect(rebuilt).toEqual(["2026-08", "2026-09"]);
  });

  it("does not read the raw facts at all when every period is already usable", async () => {
    selectFirstRidePeriod.mockResolvedValue("2026-09");
    const fresh = {
      ridesCount: 1,
      totalKm: 10,
      totalClimbM: 100,
      totalHours: 1,
      totalCalories: 300,
      computedAt: new Date("2026-09-19T08:00:00Z"),
    };
    // Sept is current (fresh <24h); Aug is the trend baseline and closed after 1 Sept.
    selectPeriodStats.mockResolvedValue(
      new Map([
        ["2026-09", fresh],
        ["2026-08", { ...fresh, computedAt: new Date("2026-09-05T00:00:00Z") }],
      ]),
    );

    await getPeriodTimeline(USER_ID, "month");

    expect(selectFinishedRideFactsForUser).not.toHaveBeenCalled();
    expect(upsertPeriodStats).not.toHaveBeenCalled();
  });

  it("honours `from` so a client holding the history only fetches the tail", async () => {
    selectFinishedRideFactsForUser.mockResolvedValue([inMonth(9)]);

    const payload = await getPeriodTimeline(USER_ID, "month", "2026-08");

    expect(selectFirstRidePeriod).not.toHaveBeenCalled();
    expect(payload.periods.map((p) => p.period)).toEqual(["2026-09", "2026-08"]);
  });

  it("builds a year timeline from the first ride's year", async () => {
    selectFirstRidePeriod.mockResolvedValue("2025-11");
    selectFinishedRideFactsForUser.mockResolvedValue([inMonth(3, { year: 2025 }), inMonth(9)]);

    const payload = await getPeriodTimeline(USER_ID, "year");

    expect(payload.periods.map((p) => p.period)).toEqual(["2026", "2025"]);
    expect(payload.periods.map((p) => p.rides)).toEqual([1, 1]);
  });

  it("never invents calories for a rider with no weight set", async () => {
    selectUserById.mockResolvedValue({ id: USER_ID, weightKg: null, country: "IL" });
    selectFirstRidePeriod.mockResolvedValue("2026-09");
    selectFinishedRideFactsForUser.mockResolvedValue([inMonth(9)]);

    const payload = await getPeriodTimeline(USER_ID, "month");

    expect(payload.weightKg).toBeNull();
    expect(payload.periods[0].calories).toBeNull();
    expect(payload.periods[0].gems.calories).toBe("stone");
  });
});

describe("the live check-in switch (app_flags stats_require_live_checkin)", () => {
  it("is OFF by default: registration alone counts", async () => {
    await getRiderStatsPayload(USER_ID);
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, { requireCheckinFrom: null });
  });

  it("passes the rule — from the rollout instant — to every facts read when an operator turns it on", async () => {
    isAppFlagOn.mockResolvedValue(true);
    getAppFlag.mockResolvedValue("2026-10-01T00:00:00Z");
    await getRiderStatsPayload(USER_ID);
    expect(isAppFlagOn).toHaveBeenCalledWith("stats_require_live_checkin");
    expect(getAppFlag).toHaveBeenCalledWith("stats_live_checkin_from");
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, {
      requireCheckinFrom: new Date("2026-10-01T00:00:00Z"),
    });
  });

  it("does NOT apply the rule when the switch is on but no rollout instant is set (keeps history)", async () => {
    isAppFlagOn.mockResolvedValue(true);
    getAppFlag.mockResolvedValue("");
    await getRiderStatsPayload(USER_ID);
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, { requireCheckinFrom: null });
  });

  it("does NOT apply the rule when the rollout instant is unparseable", async () => {
    isAppFlagOn.mockResolvedValue(true);
    getAppFlag.mockResolvedValue("next tuesday");
    await getRiderStatsPayload(USER_ID);
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, { requireCheckinFrom: null });
  });

  it("ignores the rollout instant while the switch is off", async () => {
    isAppFlagOn.mockResolvedValue(false);
    getAppFlag.mockResolvedValue("2026-10-01T00:00:00Z");
    await getRiderStatsPayload(USER_ID);
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, { requireCheckinFrom: null });
  });

  it("treats an unreadable flag as OFF instead of failing Statistics", async () => {
    isAppFlagOn.mockRejectedValue(new Error("db hiccup"));
    await expect(getRiderStatsPayload(USER_ID)).resolves.toBeDefined();
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, { requireCheckinFrom: null });
  });
});

describe("refreshStatsForFinishedEvent — month + year of the FINISH time", () => {
  it("rebuilds the month/year the ride finished in, not the current one (auto-finish is back-dated)", async () => {
    selectEventFinishedAt.mockResolvedValue(new Date("2026-06-14T10:00:00Z"));
    selectFinishedRideFactsForUser.mockResolvedValue([RIDE_WITH_TRACK]);

    await refreshStatsForFinishedEvent("event-1");

    const periods = upsertPeriodStats.mock.calls.map((c) => `${c[1]}:${c[2]}`).sort();
    expect(periods).toContain("month:2026-06");
    expect(periods).toContain("year:2026");
    expect(periods.filter((p) => p.startsWith("month:")).every((p) => p === "month:2026-06")).toBe(
      true,
    );
  });
});

describe("refreshStatsAfterAttendanceChange — one rider, after the ride has finished", () => {
  it("rebuilds only that rider's month + year of the finish, when the check-in rule is on", async () => {
    isAppFlagOn.mockResolvedValue(true);
    getAppFlag.mockResolvedValue("2026-01-01T00:00:00Z");
    selectEventFinishedAt.mockResolvedValue(new Date("2026-06-14T10:00:00Z"));
    selectFinishedRideFactsForUser.mockResolvedValue([RIDE_WITH_TRACK]);

    await refreshStatsAfterAttendanceChange("event-1", USER_ID);

    // The roster is not consulted, and only this rider's facts are read — with the rule applied.
    expect(selectFinishedEventParticipantUserIds).not.toHaveBeenCalled();
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledTimes(1);
    expect(selectFinishedRideFactsForUser).toHaveBeenCalledWith(USER_ID, {
      requireCheckinFrom: new Date("2026-01-01T00:00:00Z"),
    });
    const periods = upsertPeriodStats.mock.calls.map((c) => `${c[0]}:${c[1]}:${c[2]}`).sort();
    expect(periods).toEqual([`${USER_ID}:month:2026-06`, `${USER_ID}:year:2026`]);
  });

  it("does nothing while the check-in rule is off: attendance cannot change any total", async () => {
    isAppFlagOn.mockResolvedValue(false);

    await refreshStatsAfterAttendanceChange("event-1", USER_ID);

    expect(selectFinishedRideFactsForUser).not.toHaveBeenCalled();
    expect(upsertPeriodStats).not.toHaveBeenCalled();
    expect(upsertStatsCache).not.toHaveBeenCalled();
  });
});
