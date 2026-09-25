// "Near me" (routes.start_lat/start_lon, already indexed since sql/004 — no migration needed):
// a plain-SQL haversine sort/filter on GET /events/public. No test database: ../db/pool.js is
// stubbed and the assertions are on what was asked of it.

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

const { selectPublicEvents } = await import("./event.queries.js");

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue([]);
  queryOne.mockResolvedValue({ count: "0" });
});

describe("selectPublicEvents — near me", () => {
  const base = { sort: "newest" as const, limit: 24, offset: 0 };

  it("binds nearLat/nearLon/nearRadiusKm as null when not sent, with no radius cutoff", async () => {
    await selectPublicEvents(base);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[16]).toBeNull();
    expect(params[17]).toBeNull();
    expect(params[18]).toBeNull();
    // The cutoff clause is always present (one constant statement), but $19 IS NULL
    // short-circuits it — no row is ever excluded when no near-me search was made.
    expect(sql).toContain("$19::float8 IS NULL OR $17::float8 IS NULL OR $18::float8 IS NULL");
  });

  it("binds lat/lon/radius in order, right after favoritesOnly", async () => {
    await selectPublicEvents({ ...base, nearLat: 32.05, nearLon: 34.78, nearRadiusKm: 10 });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[16]).toBe(32.05);
    expect(params[17]).toBe(34.78);
    expect(params[18]).toBe(10);
  });

  it("computes distance against the route's start point, not the event row", async () => {
    await selectPublicEvents({ ...base, nearLat: 32.05, nearLon: 34.78 });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("route_summary.start_lat");
    expect(sql).toContain("route_summary.start_lon");
    expect(sql).toMatch(/AS distance_from_me_km/);
  });

  it('"near_me" sort orders by the same distance expression, nulls last', async () => {
    await selectPublicEvents({ ...base, sort: "near_me", nearLat: 32.05, nearLon: 34.78 });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY .*ASIN.*ASC NULLS LAST, e\.created_at DESC, e\.id/);
  });

  it("radius cutoff applies to the COUNT too — same where/params, no extra work", async () => {
    await selectPublicEvents({ ...base, nearLat: 32.05, nearLon: 34.78, nearRadiusKm: 10 });

    const [countSql, countParams] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(countSql).toContain("$19::float8 IS NULL OR $17::float8 IS NULL");
    expect(countParams[16]).toBe(32.05);
    expect(countParams[17]).toBe(34.78);
    expect(countParams[18]).toBe(10);
  });

  it("a radius with no position is ignored, never excludes every row", async () => {
    await selectPublicEvents({ ...base, nearRadiusKm: 10 });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // $19 (radius) is set but $17/$18 (lat/lon) are null — the OR short-circuits the cutoff.
    expect(params[16]).toBeNull();
    expect(params[17]).toBeNull();
    expect(params[18]).toBe(10);
    expect(sql).toContain("$19::float8 IS NULL OR $17::float8 IS NULL OR $18::float8 IS NULL");
  });

  it("trail filters after near-me still number from $20, and LIMIT/OFFSET follow", async () => {
    await selectPublicEvents({
      ...base,
      nearLat: 32.05,
      nearLon: 34.78,
      nearRadiusKm: 10,
      season: ["all_year"],
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.season = ANY($20::text[])");
    expect(sql).toContain("LIMIT $21 OFFSET $22");
    expect(params.slice(19)).toEqual([["all_year"], 24, 0]);
  });
});
