// Cover for track likes and favourites (sql/036-route-likes.sql).
//
// The property that matters most here is not any single assertion but the SQL text: a LIKE is
// append-only and its count must never go down, while a FAVOURITE is the rider's own bookmark
// and must really be removable. So one test asserts there is no UPDATE or DELETE against
// route_likes anywhere in the module, and another asserts the DELETE against route_favorites
// is present — the two rules are opposites and both are easy to break by copying the wrong
// neighbouring function.
//
// Same harness as routeCopy.queries.test.ts: this repo has no test database, so ../db/pool.js
// is stubbed and the assertions are on the SQL text handed to it. That proves the STATEMENT is
// the intended one, not that Postgres agrees with our reading of it.

import { readFileSync } from "node:fs";
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

const {
  deleteRouteFavorite,
  insertRouteFavorite,
  insertRouteLike,
  selectRouteFavoritedByUser,
  selectRouteLikeCount,
  selectRouteLikeCounts,
  selectRouteLikedByUser,
} = await import("./routeLike.queries.js");

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
});

describe("insertRouteLike", () => {
  it("leans on the unique index to dedupe rather than checking first", async () => {
    queryOne.mockResolvedValue({ id: 1 });

    const written = await insertRouteLike(42, 7);

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO route_likes/i);
    expect(sql).toMatch(/ON CONFLICT \(route_id, user_id\) DO NOTHING/i);
    expect(params).toEqual([42, 7]);
    expect(written).toBe(true);
  });

  it("reports false when the rider had already liked this track", async () => {
    // ON CONFLICT DO NOTHING returns no row. That is the second press, and it is not an error.
    queryOne.mockResolvedValue(null);
    expect(await insertRouteLike(42, 7)).toBe(false);
  });
});

describe("selectRouteLikeCount", () => {
  it("counts the rows rather than reading a stored counter", async () => {
    queryOne.mockResolvedValue({ count: "3" });

    const count = await selectRouteLikeCount(42);

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    // Still counted from the rows; the imported starting count (sql/043) is ADDED to it.
    expect(sql).toMatch(
      /SELECT COUNT\(\*\)[\s\S]*imported_like_count[\s\S]*FROM route_likes WHERE route_id = \$1/i,
    );
    expect(params).toEqual([42]);
    // Postgres returns COUNT as a string; the caller must get a number.
    expect(count).toBe(3);
  });

  it("falls back to the real rows alone on a database without sql/043", async () => {
    queryOne
      .mockRejectedValueOnce(
        Object.assign(new Error('column "imported_like_count" does not exist'), { code: "42703" }),
      )
      .mockResolvedValueOnce({ count: "2" });

    expect(await selectRouteLikeCount(42)).toBe(2);
    expect(queryOne.mock.calls[1][0]).toMatch(/SELECT COUNT\(\*\) AS count FROM route_likes/);
    expect(queryOne.mock.calls[1][0]).not.toContain("imported_like_count");
  });

  it("does not swallow an unrelated database error", async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "XX000" }));
    await expect(selectRouteLikeCount(42)).rejects.toThrow("boom");
  });

  it("reads a track nobody has liked as 0, not null", async () => {
    queryOne.mockResolvedValue(null);
    expect(await selectRouteLikeCount(42)).toBe(0);
  });
});

describe("selectRouteLikeCounts", () => {
  it("does not go to the database for an empty list", async () => {
    expect(await selectRouteLikeCounts([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a map keyed by number, so a track with no likes is simply absent", async () => {
    query.mockResolvedValue([{ route_id: "42", count: "2" }]);

    const counts = await selectRouteLikeCounts([42, 43]);

    expect(counts.get(42)).toBe(2);
    expect(counts.get(43)).toBeUndefined();
  });
});

describe("selectRouteLikedByUser / selectRouteFavoritedByUser", () => {
  it("answer true only when a row exists", async () => {
    queryOne.mockResolvedValueOnce({ id: 1 });
    expect(await selectRouteLikedByUser(42, 7)).toBe(true);

    queryOne.mockResolvedValueOnce(null);
    expect(await selectRouteFavoritedByUser(42, 7)).toBe(false);
  });
});

describe("favourites", () => {
  it("insert is idempotent the same way a like is", async () => {
    queryOne.mockResolvedValue({ id: 1 });

    await insertRouteFavorite(42, 7);

    const [sql] = queryOne.mock.calls[0] as [string];
    expect(sql).toMatch(/INSERT INTO route_favorites/i);
    expect(sql).toMatch(/ON CONFLICT \(route_id, user_id\) DO NOTHING/i);
  });

  it("delete really removes the rider's own row, and only theirs", async () => {
    queryOne.mockResolvedValue({ id: 1 });

    const removed = await deleteRouteFavorite(42, 7);

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM route_favorites WHERE route_id = \$1 AND user_id = \$2/i);
    expect(params).toEqual([42, 7]);
    expect(removed).toBe(true);
  });
});

describe("the append-only rule", () => {
  // THE GUARD. A like must never be revoked, because the public count it feeds must never go
  // down — the same rule route_copies lives by (sql/025) and for the same reason. If a product
  // decision ever introduces "unlike", it needs a new conversation about what happens to the
  // count, not a quiet edit to this module.
  it("has no UPDATE or DELETE against route_likes anywhere in the module", () => {
    const source = readFileSync(new URL("./routeLike.queries.ts", import.meta.url), "utf8");
    const statements = source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    expect(statements).not.toMatch(/DELETE\s+FROM\s+route_likes/i);
    expect(statements).not.toMatch(/UPDATE\s+route_likes/i);
  });

  // The other half, and the reason the two tables are separate: a bookmark is private and
  // uncounted, so removing it has to actually remove it.
  it("does delete from route_favorites", () => {
    const source = readFileSync(new URL("./routeLike.queries.ts", import.meta.url), "utf8");
    const statements = source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    expect(statements).toMatch(/DELETE\s+FROM\s+route_favorites/i);
  });
});
