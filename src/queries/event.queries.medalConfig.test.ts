// Regression cover for the completion-medal config write (sql/061). The repo has no test
// database, so ../db/pool.js is stubbed and the assertions are on the SQL text + bound params.
//
// The bug this guards against (prod, 2026-10-08): three of the four SET clauses were built as
// `medal_text = 3` instead of `medal_text = $3` — a literal integer into a text column — so
// creating a ride with a medal 500'd after the ride row was already inserted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: vi.fn(),
}));

const { updateEventMedalConfig } = await import("./event.queries.js");

beforeEach(() => {
  execute.mockReset().mockResolvedValue(1);
});

describe("updateEventMedalConfig", () => {
  it("binds every column to its own placeholder, in order", async () => {
    await updateEventMedalConfig("e1", {
      medalEnabled: true,
      medalText: "מדליית הוקרה",
      medalColorId: "sage",
      medalStyleId: "sunburst",
    });
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toBe(
      "UPDATE events SET medal_enabled = $2, medal_text = $3, medal_color_id = $4, medal_style_id = $5, updated_at = NOW() WHERE id = $1",
    );
    expect(params).toEqual(["e1", true, "מדליית הוקרה", "sage", "sunburst"]);
  });

  it("every placeholder in the SET list refers to a bound parameter — never a bare number", async () => {
    await updateEventMedalConfig("e1", { medalText: "x", medalStyleId: "glow" });
    const [sql, params] = execute.mock.calls[0];
    const setList = String(sql).slice("UPDATE events SET ".length, String(sql).indexOf(", updated_at"));
    for (const clause of setList.split(", ")) {
      expect(clause).toMatch(/^medal_[a-z_]+ = \$\d+$/);
      const index = Number(clause.split("$")[1]);
      expect(index).toBeGreaterThanOrEqual(2);
      expect(index).toBeLessThanOrEqual(params.length);
    }
    expect(params).toEqual(["e1", "x", "glow"]);
  });

  it("nothing to write = no statement", async () => {
    await updateEventMedalConfig("e1", {});
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("deleteHalfCreatedEvent", () => {
  it("removes the ride and only the rows createEvent wrote for it, in one transaction", async () => {
    const pool = await import("../db/pool.js");
    const statements: unknown[][] = [];
    vi.mocked(pool.withTransaction).mockImplementation(async (fn) =>
      fn({
        query: async (sql: string, params?: unknown[]) => {
          statements.push([sql, params]);
          return [];
        },
        queryOne: async () => null,
      } as never),
    );
    const { deleteHalfCreatedEvent } = await import("./event.queries.js");
    await deleteHalfCreatedEvent("e1");
    expect(statements).toEqual([
      ["DELETE FROM event_participants WHERE event_id = $1", ["e1"]],
      ["DELETE FROM event_members WHERE event_id = $1", ["e1"]],
      ["DELETE FROM events WHERE id = $1", ["e1"]],
    ]);
  });
});
