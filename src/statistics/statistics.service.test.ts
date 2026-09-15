// statistics.service.ts is the whole point of the cache: read cached-if-fresh, recompute
// (from real per-ride facts) if stale/missing, and never invent a calorie number for a rider
// with no weight set. No test database, so the queries layer is stubbed — same harness as
// event.service.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectFinishedRideFactsForUser = vi.fn();
const selectFinishedEventParticipantUserIds = vi.fn();
const selectStatsCache = vi.fn();
const upsertStatsCache = vi.fn();
const selectLeaderboard = vi.fn();
const selectUserById = vi.fn();

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
  };
});

vi.mock("../queries/user.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/user.queries.js")>(
    "../queries/user.queries.js",
  );
  return { ...actual, selectUserById: (...a: unknown[]) => selectUserById(...a) };
});

const { getRiderStatsPayload, getLeaderboard, refreshStatsForFinishedEvent } = await import(
  "./statistics.service.js"
);

const USER_ID = 42;

/** A finished ride with a real GPS track (so a real duration -> real speed is used). */
const RIDE_WITH_TRACK = {
  eventId: "e1",
  year: 2026,
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
