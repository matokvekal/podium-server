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

const {
  insertDrawnRouteRow,
  publishEventRouteIfOwned,
  selectEventRouteGeometry,
  selectEventRouteId,
} = await import("./eventRoute.queries.js");

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

describe("the per-point elevation series", () => {
  it("comes back parallel to the points when the geometry carries it", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8, ele: 12 },
        { lat: 32.2, lng: 34.9, ele: 48 },
        { lat: 32.3, lng: 35.0, ele: 31 },
      ],
      distance_km: 40,
      elevation_m: 300,
    });

    const route = await selectEventRouteGeometry("e1");

    expect(route?.points).toHaveLength(3);
    expect(route?.elevations).toEqual([12, 48, 31]);
  });

  it("is absent entirely for a tuple route, so the old response body is unchanged", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        [32.1, 34.8],
        [32.2, 34.9],
      ],
      distance_km: 40,
      elevation_m: 300,
    });

    const route = await selectEventRouteGeometry("e1");

    expect(route).not.toHaveProperty("elevations");
  });

  it("is absent when object geometry carries no elevation at all", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8 },
        { lat: 32.2, lng: 34.9 },
      ],
      distance_km: 40,
      elevation_m: null,
    });

    expect(await selectEventRouteGeometry("e1")).not.toHaveProperty("elevations");
  });

  it("nulls the gaps when only some points carry elevation", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8, ele: 12 },
        { lat: 32.2, lng: 34.9 },
        { lat: 32.3, lng: 35.0, ele: 31 },
      ],
      distance_km: 40,
      elevation_m: null,
    });

    expect((await selectEventRouteGeometry("e1"))?.elevations).toEqual([12, null, 31]);
  });

  it("rejects an unusable elevation value rather than storing NaN on the route", async () => {
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8, ele: "high" },
        { lat: 32.2, lng: 34.9, ele: 48 },
      ],
      distance_km: 40,
      elevation_m: null,
    });

    expect((await selectEventRouteGeometry("e1"))?.elevations).toEqual([null, 48]);
  });

  it("drops a malformed point from BOTH arrays, so the two stay aligned", async () => {
    // The whole point of building them in one pass: if the bad point were dropped from the
    // line but not the series, every elevation after it would belong to the wrong place.
    queryOne.mockResolvedValue({
      id: 1,
      track_points: [
        { lat: 32.1, lng: 34.8, ele: 12 },
        { lat: "nope", lng: 34.9, ele: 999 },
        { lat: 32.3, lng: 35.0, ele: 31 },
      ],
      distance_km: 40,
      elevation_m: null,
    });

    const route = await selectEventRouteGeometry("e1");

    expect(route?.points).toEqual([
      [32.1, 34.8],
      [32.3, 35.0],
    ]);
    expect(route?.elevations).toEqual([12, 31]);
    expect(route?.elevations).toHaveLength(route?.points.length ?? 0);
  });
});

describe("insertDrawnRouteRow geometry shape", () => {
  /** The JSONB written to track_points, as the caller passed it. */
  function storedGeometry(): unknown {
    return JSON.parse(queryOne.mock.calls[0][1][3] as string);
  }

  it("writes plain tuples when there is no elevation — an unchanged upload stores the same row", async () => {
    queryOne.mockResolvedValue({
      id: 7,
      track_points: [
        [32.1, 34.8],
        [32.2, 34.9],
      ],
      distance_km: 40,
      elevation_m: null,
    });

    await insertDrawnRouteRow(
      1,
      {
        points: [
          [32.1, 34.8],
          [32.2, 34.9],
        ],
        elevations: null,
      },
      40,
      null,
      false,
    );

    expect(storedGeometry()).toEqual([
      [32.1, 34.8],
      [32.2, 34.9],
    ]);
  });

  it("writes objects when an elevation series came with the upload", async () => {
    queryOne.mockResolvedValue({
      id: 7,
      track_points: [{ lat: 32.1, lng: 34.8, ele: 12 }],
      distance_km: 40,
      elevation_m: 300,
    });

    await insertDrawnRouteRow(
      1,
      {
        points: [
          [32.1, 34.8],
          [32.2, 34.9],
        ],
        elevations: [12, null],
      },
      40,
      300,
      false,
    );

    expect(storedGeometry()).toEqual([
      { lat: 32.1, lng: 34.8, ele: 12 },
      { lat: 32.2, lng: 34.9, ele: null },
    ]);
  });

  it("falls back to tuples if the series does not line up with the points", async () => {
    queryOne.mockResolvedValue({
      id: 7,
      track_points: [[32.1, 34.8]],
      distance_km: 40,
      elevation_m: null,
    });

    await insertDrawnRouteRow(
      1,
      {
        points: [
          [32.1, 34.8],
          [32.2, 34.9],
        ],
        elevations: [12],
      },
      40,
      null,
      false,
    );

    expect(storedGeometry()).toEqual([
      [32.1, 34.8],
      [32.2, 34.9],
    ]);
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

describe("publishEventRouteIfOwned", () => {
  it("publishes only a track the ride's owner also owns", async () => {
    execute.mockResolvedValue(1);

    const published = await publishEventRouteIfOwned("e1", 7);

    expect(published).toBe(1);
    const [sql, values] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE routes r/);
    expect(sql).toMatch(/SET is_public = TRUE/);
    expect(sql).toMatch(/er\.event_id = \$1/);
    // THE GUARD THAT MATTERS. Copying a track attaches the ORIGINAL row, so a ride very often
    // points at someone else's route. Without this, taking your own ride public would publish a
    // stranger's track into Find Tracks on their behalf.
    expect(sql).toMatch(/r\.owner_id = \$2/);
    expect(values).toEqual(["e1", 7]);
  });

  it("is a no-op when the track is already public", async () => {
    // `AND r.is_public = FALSE` keeps the common PATCH from writing a row and bumping updated_at.
    execute.mockResolvedValue(0);

    expect(await publishEventRouteIfOwned("e1", 7)).toBe(0);
    expect(execute.mock.calls[0][0]).toMatch(/r\.is_public = FALSE/);
  });

  it("never publishes a borrowed track — no row matches, nothing is written", async () => {
    execute.mockResolvedValue(0);

    expect(await publishEventRouteIfOwned("e1", 999)).toBe(0);
  });
});
