// Cover for the track-copy ledger (sql/025-track-copy-lineage.sql).
//
// The property that matters most here is not tested by any single assertion but by the SQL
// text: this table is APPEND-ONLY, and the count it feeds must never go down. So one test
// asserts there is no UPDATE and no DELETE anywhere in the module, and the insert test asserts
// the ON CONFLICT clause that makes a re-save a no-op rather than a second count.
//
// Same harness as event.queries.test.ts: this repo has no test database, so ../db/pool.js is
// stubbed and assertions are on the SQL text plus the shape the mapper returns.

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

const { insertRouteCopy, selectRouteCopyCount, selectRouteCopyCounts } = await import(
  "./routeCopy.queries.js"
);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
});

describe("insertRouteCopy", () => {
  it("inserts the four fields and leans on the unique index to dedupe", async () => {
    queryOne.mockResolvedValue({ id: 1 });

    const written = await insertRouteCopy({
      routeId: 42,
      copiedByUserId: 7,
      newEventId: "11111111-1111-1111-1111-111111111111",
      sourceEventId: "22222222-2222-2222-2222-222222222222",
    });

    expect(written).toBe(true);
    const [sql, values] = queryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO route_copies/);
    // Without this, a ride that re-saves would count again every time.
    expect(sql).toMatch(/ON CONFLICT \(route_id, new_event_id\) DO NOTHING/);
    expect(values).toEqual([
      42,
      7,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("reports false when the ride was already counted against this track", async () => {
    // What ON CONFLICT DO NOTHING returns: no row, because nothing was inserted.
    queryOne.mockResolvedValue(null);

    const written = await insertRouteCopy({
      routeId: 42,
      copiedByUserId: 7,
      newEventId: "11111111-1111-1111-1111-111111111111",
      sourceEventId: null,
    });

    expect(written).toBe(false);
  });

  it("writes a null source ride for a track picked from Find Tracks", async () => {
    queryOne.mockResolvedValue({ id: 2 });

    await insertRouteCopy({
      routeId: 42,
      copiedByUserId: 7,
      newEventId: "11111111-1111-1111-1111-111111111111",
      sourceEventId: null,
    });

    const [, values] = queryOne.mock.calls[0];
    expect(values[3]).toBeNull();
  });
});

describe("selectRouteCopyCount", () => {
  it("counts the ledger rows for one track", async () => {
    queryOne.mockResolvedValue({ count: "3" }); // pg returns COUNT(*) as a string
    expect(await selectRouteCopyCount(42)).toBe(3);
    const [sql, values] = queryOne.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\)[\s\S]*FROM route_copies[\s\S]*WHERE route_id = \$1/);
    expect(values).toEqual([42]);
  });

  it("reads an untouched track as 0, not null", async () => {
    queryOne.mockResolvedValue(null);
    expect(await selectRouteCopyCount(42)).toBe(0);
  });
});

describe("selectRouteCopyCounts", () => {
  it("asks nothing of the database for an empty list", async () => {
    expect(await selectRouteCopyCounts([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a map, leaving an uncopied track absent rather than 0", async () => {
    query.mockResolvedValue([
      { route_id: 1, count: "2" },
      { route_id: 3, count: 5 },
    ]);

    const counts = await selectRouteCopyCounts([1, 2, 3]);

    expect(counts.get(1)).toBe(2);
    expect(counts.get(3)).toBe(5);
    expect(counts.has(2)).toBe(false); // callers read this as `?? 0`
  });
});

describe("the ledger is append-only", () => {
  it("contains no UPDATE and no DELETE against route_copies", () => {
    // A guard on the invariant the whole feature rests on: the count may never go down, so
    // nothing in this module may ever remove or rewrite a row. If a future change adds one,
    // this fails and sends the reader to sql/025's WHY block before they ship it.
    const source = readFileSync(new URL("./routeCopy.queries.ts", import.meta.url), "utf8");
    const statements = source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    expect(statements).not.toMatch(/DELETE\s+FROM\s+route_copies/i);
    expect(statements).not.toMatch(/UPDATE\s+route_copies/i);
  });
});
