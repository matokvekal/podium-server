// GET /routes/:routeId must hand geometry over as [lat, lng] tuples, whichever shape the row
// is stored in.
//
// This exists because it already broke once. routes.track_points holds two shapes — tuples,
// and {lat, lng, ele} objects once a route carries per-point elevation (see the box atop
// queries/eventRoute.queries.ts). toRouteSummary ran preview_points through the normalizer
// from the start, but toRouteDetail handed track_points over raw, so the moment routes began
// storing objects a route WITH elevation reached the client in a shape its tuple contract
// cannot read: no elevation profile under the map, and no start point for the region guess.
//
// The two directions pinned here are "objects normalize to tuples plus a parallel series" and
// "tuples are passed through untouched, with no elevations field invented" — the second is
// what keeps every route already in the library responding byte-for-byte as it did.
//
// Same stubbing story as event.controller.test.ts: no test database, and importing the
// controller pulls ../db/pool.js in transitively even though these mappers never touch it.

import { describe, expect, it, vi } from "vitest";

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { toRouteDetail } = await import("./routeLibrary.controller.js");

/** Only the fields the mappers actually read; the rest of RouteWithOwner is irrelevant here. */
function routeWith(trackPoints: unknown, previewPoints: unknown = null) {
  return {
    id: 42,
    ownerId: 7,
    ownerName: "Dana",
    name: "Airport City loop",
    routeType: null,
    source: "gpx",
    placeName: null,
    isPublic: true,
    distanceKm: 41.2,
    elevationM: 380,
    pointCount: 3,
    trackPoints,
    previewPoints,
    markers: null,
    startLat: null,
    startLon: null,
    endLat: null,
    endLon: null,
    bboxMinLat: null,
    bboxMinLon: null,
    bboxMaxLat: null,
    bboxMaxLon: null,
    createdAt: new Date("2026-09-09T00:00:00Z"),
    updatedAt: new Date("2026-09-09T00:00:00Z"),
    // biome-ignore lint/suspicious/noExplicitAny: a partial row is the point of this fixture.
  } as any;
}

describe("toRouteDetail geometry", () => {
  it("projects {lat, lng, ele} objects to tuples plus a parallel elevation series", () => {
    const detail = toRouteDetail(
      routeWith([
        { lat: 32.01, lng: 34.88, ele: 42 },
        { lat: 32.02, lng: 34.89, ele: 47.5 },
        { lat: 32.03, lng: 34.9, ele: 51 },
      ]),
    );

    expect(detail.trackPoints).toEqual([
      [32.01, 34.88],
      [32.02, 34.89],
      [32.03, 34.9],
    ]);
    expect(detail.elevations).toEqual([42, 47.5, 51]);
  });

  it("passes stored tuples through and omits elevations entirely", () => {
    const detail = toRouteDetail(
      routeWith([
        [32.01, 34.88],
        [32.02, 34.89],
      ]),
    );

    expect(detail.trackPoints).toEqual([
      [32.01, 34.88],
      [32.02, 34.89],
    ]);
    // Absent, not null: the response body for a pre-existing route is unchanged.
    expect("elevations" in detail).toBe(false);
  });

  it("keeps the series aligned when only some points carry elevation", () => {
    const detail = toRouteDetail(
      routeWith([
        { lat: 32.01, lng: 34.88, ele: 42 },
        { lat: 32.02, lng: 34.89 },
        { lat: 32.03, lng: 34.9, ele: null },
        { lat: 32.04, lng: 34.91, ele: 60 },
      ]),
    );

    expect(detail.trackPoints).toHaveLength(4);
    expect(detail.elevations).toEqual([42, null, null, 60]);
  });

  it("drops a malformed point from both arrays rather than shifting the series", () => {
    const detail = toRouteDetail(
      routeWith([
        { lat: 32.01, lng: 34.88, ele: 42 },
        { lat: "not a number", lng: 34.89, ele: 999 },
        { lat: 32.03, lng: 34.9, ele: 51 },
      ]),
    );

    expect(detail.trackPoints).toEqual([
      [32.01, 34.88],
      [32.03, 34.9],
    ]);
    expect(detail.elevations).toEqual([42, 51]);
  });

  it("omits elevations for objects that carry no readable value at all", () => {
    const detail = toRouteDetail(
      routeWith([
        { lat: 32.01, lng: 34.88 },
        { lat: 32.02, lng: 34.89, ele: null },
      ]),
    );

    expect(detail.trackPoints).toHaveLength(2);
    expect("elevations" in detail).toBe(false);
  });

  it("survives a route with no geometry", () => {
    const detail = toRouteDetail(routeWith(null));

    expect(detail.trackPoints).toBeNull();
    expect("elevations" in detail).toBe(false);
  });
});
