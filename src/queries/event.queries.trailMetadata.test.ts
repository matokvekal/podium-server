// events.route_difficulty / season / shade (sql/041): the write goes with the ride plan, the read
// maps to null on an old database, and the public-list filters add SQL only when they are used.
// No test database: ../db/pool.js is stubbed and the assertions are on what was asked of it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: vi.fn(),
}));

const { updateEventRidePlan, selectPublicEvents } = await import("./event.queries.js");

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue(1);
  query.mockResolvedValue([]);
  queryOne.mockResolvedValue({ count: "0" });
});

describe("updateEventRidePlan — trail metadata in the batch", () => {
  it("writes all three alongside the rest, parameterized, in one statement", async () => {
    await updateEventRidePlan("e1", {
      durationMin: 240,
      routeDifficulty: "hard",
      season: "winter_spring",
      shade: "exposed",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [text, params] = execute.mock.calls[0];
    expect(text).toContain("route_difficulty = $");
    expect(text).toContain("season = $");
    expect(text).toContain("shade = $");
    expect(params).toEqual(expect.arrayContaining(["hard", "winter_spring", "exposed"]));
    expect(text).not.toContain("'hard'");
  });

  it("null clears a value; an absent key leaves it alone", async () => {
    await updateEventRidePlan("e1", { routeDifficulty: null });
    const [text, params] = execute.mock.calls[0];
    expect(text).toContain("route_difficulty = $");
    expect(params).toContain(null);
    expect(text).not.toContain("season");
    expect(text).not.toContain("shade");
  });

  it("on a database without sql/041 drops only the missing column and keeps the rest", async () => {
    const missing = Object.assign(
      new Error('column "season" of relation "events" does not exist'),
      { code: "42703" },
    );
    execute.mockRejectedValueOnce(missing).mockResolvedValue(1);

    await updateEventRidePlan("e1", { durationMin: 90, season: "all_year", shade: "shaded" });

    expect(execute).toHaveBeenCalledTimes(2);
    const [retryText] = execute.mock.calls[1];
    expect(retryText).toContain("duration_min");
    expect(retryText).toContain("shade");
    expect(retryText).not.toContain("season");
  });
});

describe("selectPublicEvents — trail filters", () => {
  const base = { sort: "newest" as const, limit: 24, offset: 48 };

  it("adds no reference to the sql/041 columns when no trail filter is sent", async () => {
    await selectPublicEvents(base);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain("route_difficulty");
    expect(sql).not.toContain("e.season");
    expect(sql).not.toContain("e.shade");
    expect(sql).toContain("LIMIT $17 OFFSET $18");
  });

  it("binds each filter as its own array parameter and moves LIMIT / OFFSET after them", async () => {
    await selectPublicEvents({
      ...base,
      routeDifficulty: ["easy", "moderate"],
      shade: ["shaded"],
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.route_difficulty = ANY($17::text[])");
    expect(sql).toContain("e.shade = ANY($18::text[])");
    expect(sql).not.toContain("e.season");
    expect(sql).toContain("LIMIT $19 OFFSET $20");
    expect(params.slice(16)).toEqual([["easy", "moderate"], ["shaded"], 24, 48]);
  });

  it("applies the same clauses to the COUNT so the total matches the page", async () => {
    await selectPublicEvents({ ...base, season: ["all_year"] });

    const [countSql, countParams] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(countSql).toContain("e.season = ANY($17::text[])");
    expect(countParams).toHaveLength(17);
    expect(countParams[16]).toEqual(["all_year"]);
  });
});
