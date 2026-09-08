// The elevation series on POST /events/:eventId/route is additive and optional, so the two
// things worth pinning down are that a body without it still validates exactly as before, and
// that a series which does not line up with the points is refused at the door rather than
// stored as a profile that silently disagrees with the line above it.

import { describe, expect, it } from "vitest";
import { setEventRouteSchema } from "./eventRoute.schemas.js";

const points: [number, number][] = [
  [32.1, 34.8],
  [32.2, 34.9],
  [32.3, 35.0],
];

describe("setEventRouteSchema elevations", () => {
  it("accepts a body with no elevations at all — the shape every client sent before", () => {
    const result = setEventRouteSchema.safeParse({ points, distanceKm: 40, elevationM: 300 });

    expect(result.success).toBe(true);
    expect(result.data?.elevations).toBeUndefined();
  });

  it("accepts one elevation per point", () => {
    const result = setEventRouteSchema.safeParse({
      points,
      distanceKm: 40,
      elevationM: 300,
      elevations: [12, 48, 31],
    });

    expect(result.success).toBe(true);
    expect(result.data?.elevations).toEqual([12, 48, 31]);
  });

  it("accepts nulls for points whose elevation was missing from the file", () => {
    const result = setEventRouteSchema.safeParse({
      points,
      distanceKm: 40,
      elevations: [12, null, 31],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a series with too few entries", () => {
    const result = setEventRouteSchema.safeParse({
      points,
      distanceKm: 40,
      elevations: [12, 48],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["elevations"]);
  });

  it("rejects a series with too many entries", () => {
    const result = setEventRouteSchema.safeParse({
      points,
      distanceKm: 40,
      elevations: [12, 48, 31, 7],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric elevation", () => {
    const result = setEventRouteSchema.safeParse({
      points,
      distanceKm: 40,
      elevations: [12, "high", 31],
    });

    expect(result.success).toBe(false);
  });
});
