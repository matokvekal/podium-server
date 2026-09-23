// sql/048 — when a ride actually went live. Written once, and never allowed to break going live.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db/pool.js", () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { markEventStarted } = await import("./event.queries.js");

beforeEach(() => {
  query.mockReset();
});

describe("markEventStarted", () => {
  it("stamps started_at only if it is not set yet (a pause/resume never moves it)", async () => {
    const at = new Date("2026-09-23T06:45:00Z");
    query.mockResolvedValue([{ started_at: at }]);

    await expect(markEventStarted("e1")).resolves.toBe(at);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("started_at = COALESCE(started_at, NOW())");
    expect(params).toEqual(["e1"]);
  });

  it("answers null instead of failing on a database without sql/048", async () => {
    query.mockRejectedValue(
      Object.assign(new Error('column "started_at" does not exist'), { code: "42703" }),
    );
    await expect(markEventStarted("e1")).resolves.toBeNull();
  });

  it("does not swallow an unrelated error", async () => {
    query.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }));
    await expect(markEventStarted("e1")).rejects.toThrow("boom");
  });
});
