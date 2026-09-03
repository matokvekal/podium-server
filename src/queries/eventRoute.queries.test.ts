// Cover for the two-shapes normalizer on the event-attached route read.
//
// WHY THIS EXISTS: routes.track_points genuinely holds both [lat, lng] tuples (insertDrawnRouteRow)
// and {lat, lng, ele} objects (routeLibrary's insertRoute) — see the warning block at the top of
// eventRoute.queries.ts. This projection casts to tuples, so an object-shaped route reaching
// GET /events/:eventId/route used to hand the client objects where its EventRoute type expects
// tuples: the map renders nothing, silently, with no error to explain it.
//
// It never fired while every copy FORKED a fresh tuple-shaped row. Copying now attaches the
// original row instead, so this read path can reach rows it never used to.
//
// Same harness as event.queries.test.ts — no test database, so ../db/pool.js is stubbed.

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

const { selectEventRouteGeometry, selectEventRouteId } = await import("./eventRoute.queries.js");

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
});

describe("selectEventRouteGeometry point shapes", () => {
  it("passes tuple geometry through untouched — every row stored today", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        [32.1, 34.8],
        [32.2, 34.9],
      ],
      distance_km: 40,
      elevation_m: 300,
    });

    expect(await selectEventRouteGeometry("e1")).toEqual({
      points: [
        [32.1, 34.8],
        [32.2, 34.9],
      ],
      distanceKm: 40,
      elevationM: 300,
    });
  });

  it("normalizes object geometry to tuples instead of handing the client an unusable map", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8, ele: 12 },
        { lat: 32.2, lng: 34.9 },
      ],
      distance_km: 40,
      elevation_m: null,
    });

    const route = await selectEventRouteGeometry("e1");

    expect(route?.points).toEqual([
      [32.1, 34.8],
      [32.2, 34.9],
    ]);
  });

  it("drops a point in neither shape rather than passing garbage on to be drawn", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [[32.1, 34.8], null, { lat: "nope", lng: 34.9 }, [32.2, 34.9]],
      distance_km: 40,
      elevation_m: null,
    });

    expect((await selectEventRouteGeometry("e1"))?.points).toEqual([
      [32.1, 34.8],
      [32.2, 34.9],
    ]);
  });

  it("reads a route with no stored geometry as an empty line, not a crash", async () => {
    queryOne.mockResolvedValue({ id: 1, track_points: null, distance_km: null, elevation_m: null });
    expect(await selectEventRouteGeometry("e1")).toEqual({
      points: [],
      distanceKm: 0,
      elevationM: null,
    });
  });

  it("still returns null when the event has no route at all", async () => {
    queryOne.mockResolvedValue(null);
    expect(await selectEventRouteGeometry("e1")).toBeNull();
  });
});

describe("selectEventRouteId", () => {
  it("reads the id alone, without opening the geometry", async () => {
    queryOne.mockResolvedValue({ route_id: 42 });

    expect(await selectEventRouteId("e1")).toBe(42);
    const [sql, values] = queryOne.mock.calls[0];
    // Moving ~116 KB of JSON per copy to throw all of it away would be the easy mistake here.
    expect(sql).not.toMatch(/track_points/);
    expect(sql).toMatch(/FROM event_routes/);
    expect(values).toEqual(["e1"]);
  });

  it("returns null for a ride with no track", async () => {
    queryOne.mockResolvedValue(null);
    expect(await selectEventRouteId("e1")).toBeNull();
  });
});
