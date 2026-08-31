// user_limits is the only thing authorization reads, so these tests are mostly about the
// FAILURE case: a user without a row must produce a loud error, never a plausible default.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
}));

const {
  applyPlanLimitsTx,
  insertUserLimitsTx,
  mapUserLimitsRow,
  selectUserLimits,
  selectUserLimitsOrThrow,
  UserLimitsNotFoundError,
} = await import("./userLimits.queries.js");

/** A stand-in Transaction that just records what was run against it. */
function fakeTx() {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    tx: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
      queryOne: async () => null,
    },
  };
}

const ROW = {
  user_id: 42,
  events_per_week: 3,
  participants_per_event: 50,
  groups_per_event: 2,
  teams_owned: 2,
  note: null,
};

beforeEach(() => query.mockReset());

describe("selectUserLimitsOrThrow", () => {
  it("returns the row's values verbatim", async () => {
    query.mockResolvedValue([{ ...ROW, events_per_week: 10 }]);

    await expect(selectUserLimitsOrThrow(42)).resolves.toEqual({
      eventsPerWeek: 10,
      participantsPerEvent: 50,
      groupsPerEvent: 2,
      teamsPerOwner: 2,
    });
  });

  it("throws when the user has no row — it does NOT fall back to the config defaults", async () => {
    query.mockResolvedValue([]);

    await expect(selectUserLimitsOrThrow(42)).rejects.toThrow(UserLimitsNotFoundError);
    // The specific trap: the old code returned null here and the caller resolved to 3.
    await expect(selectUserLimitsOrThrow(42)).rejects.toThrow(/No user_limits row for user 42/);
  });

  it("names the user, so the operator can fix the data from the log line alone", async () => {
    query.mockResolvedValue([]);
    await expect(selectUserLimitsOrThrow(7)).rejects.toMatchObject({
      name: "UserLimitsNotFoundError",
      userId: 7,
    });
  });

  it("lets a missing TABLE surface as the raw Postgres error instead of swallowing 42P01", async () => {
    // The old selectUserLimits caught 42P01 and returned null, which is how a completely
    // unapplied migration stayed invisible behind a working-looking free tier.
    query.mockImplementationOnce(() => {
      throw Object.assign(new Error('relation "user_limits" does not exist'), { code: "42P01" });
    });

    await expect(selectUserLimitsOrThrow(42)).rejects.toThrow(/does not exist/);
  });

  it("treats 0 as a real limit rather than an absent one", async () => {
    query.mockResolvedValue([{ ...ROW, events_per_week: 0 }]);
    await expect(selectUserLimitsOrThrow(42)).resolves.toMatchObject({ eventsPerWeek: 0 });
  });
});

describe("selectUserLimits", () => {
  it("returns null rather than throwing, for callers that handle absence themselves", async () => {
    query.mockResolvedValue([]);
    await expect(selectUserLimits(42)).resolves.toBeNull();
  });
});

describe("mapUserLimitsRow", () => {
  it("bridges teams_owned onto teamsPerOwner", () => {
    expect(mapUserLimitsRow({ ...ROW, teams_owned: 9 }).teamsPerOwner).toBe(9);
  });
});

describe("insertUserLimitsTx", () => {
  it("writes the configured defaults as real values", async () => {
    const { tx, calls } = fakeTx();
    await insertUserLimitsTx(tx, 42);

    expect(calls).toHaveLength(1);
    expect(calls[0].params.slice(0, 5)).toEqual([42, 3, 50, 2, 2]);
    // No NULLs: a row always carries actual numbers.
    expect(calls[0].params.slice(1, 5).some((v) => v === null)).toBe(false);
  });

  it("never stamps an existing row back down to the defaults", async () => {
    const { tx, calls } = fakeTx();
    await insertUserLimitsTx(tx, 42);

    expect(calls[0].sql).toContain("ON CONFLICT (user_id) DO NOTHING");
    expect(calls[0].sql).not.toContain("DO UPDATE");
  });

  it("accepts explicit limits, for the backfill and for tests", async () => {
    const { tx, calls } = fakeTx();
    await insertUserLimitsTx(
      tx,
      42,
      { eventsPerWeek: 30, participantsPerEvent: 500, groupsPerEvent: 10, teamsPerOwner: 5 },
      "plan:organizer_pro",
    );

    expect(calls[0].params).toEqual([42, 30, 500, 10, 5, "plan:organizer_pro"]);
  });
});

describe("applyPlanLimitsTx", () => {
  it("overwrites an existing row, because a plan change must move the numbers", async () => {
    const { tx, calls } = fakeTx();
    await applyPlanLimitsTx(
      tx,
      42,
      { eventsPerWeek: 30, participantsPerEvent: 500, groupsPerEvent: 10, teamsPerOwner: 5 },
      "plan:organizer_pro",
    );

    expect(calls[0].sql).toContain("DO UPDATE");
    expect(calls[0].params.slice(0, 5)).toEqual([42, 30, 500, 10, 5]);
  });
});
