// The 60-point card preview: geometry-aware simplification, the stored/API shapes, and the read
// side that lets a route without a backfilled thumb_points still draw (sql/046).

import { describe, expect, it } from "vitest";
import { type LatLng, simplifyIndicesToCount } from "./geo.js";
import {
  buildRoutePreview,
  isMissingThumbColumn,
  previewFromStored,
  THUMB_POINT_TARGET,
  toStoredThumb,
} from "./route-thumb.js";

/** A dead-straight west→east leg followed by a dead-straight north leg: one corner. */
function lShape(perLeg: number): LatLng[] {
  const line: LatLng[] = [];
  for (let i = 0; i <= perLeg; i++) line.push({ lat: 32, lng: 35 + (i / perLeg) * 0.02 });
  for (let i = 1; i <= perLeg; i++) line.push({ lat: 32 + (i / perLeg) * 0.02, lng: 35.02 });
  return line;
}

describe("simplifyIndicesToCount", () => {
  it("keeps everything when the line already fits", () => {
    const line = lShape(10);
    expect(simplifyIndicesToCount(line, 60)).toEqual(line.map((_, i) => i));
  });

  it("returns at most maxCount points, ascending, always keeping both ends", () => {
    const line = lShape(500);
    const kept = simplifyIndicesToCount(line, 60);
    expect(kept.length).toBeLessThanOrEqual(60);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(line.length - 1);
    expect([...kept].sort((a, b) => a - b)).toEqual(kept);
    expect(new Set(kept).size).toBe(kept.length);
  });

  it("spends a point on the corner, which an evenly-spaced thinning would miss", () => {
    const line = lShape(500); // corner is index 500
    const kept = simplifyIndicesToCount(line, 3);
    expect(kept).toEqual([0, 500, 1000]);
  });

  it("stops early on a dead-straight line instead of padding with useless points", () => {
    const straight: LatLng[] = Array.from({ length: 200 }, (_, i) => ({
      lat: 32,
      lng: 35 + i * 0.0001,
    }));
    expect(simplifyIndicesToCount(straight, 60)).toEqual([0, 199]);
  });

  it("survives a stationary trace (every point identical)", () => {
    const still: LatLng[] = Array.from({ length: 100 }, () => ({ lat: 32, lng: 35 }));
    expect(simplifyIndicesToCount(still, 60)).toEqual([0, 99]);
  });

  it("stays close to the original line on a wiggly track", () => {
    const wiggly: LatLng[] = Array.from({ length: 2000 }, (_, i) => ({
      lat: 32 + i * 0.00002 + Math.sin(i / 40) * 0.003,
      lng: 35 + i * 0.00003 + Math.cos(i / 55) * 0.003,
    }));
    const kept = simplifyIndicesToCount(wiggly, THUMB_POINT_TARGET);
    // Worst distance of any dropped point from the simplified line, in metres (flat projection).
    const kx = Math.cos((32 * Math.PI) / 180) * 111_320;
    const ky = 110_540;
    let worst = 0;
    for (let k = 0; k < kept.length - 1; k++) {
      const a = wiggly[kept[k]];
      const b = wiggly[kept[k + 1]];
      const dx = (b.lng - a.lng) * kx;
      const dy = (b.lat - a.lat) * ky;
      const len2 = dx * dx + dy * dy;
      for (let i = kept[k] + 1; i < kept[k + 1]; i++) {
        const px = (wiggly[i].lng - a.lng) * kx;
        const py = (wiggly[i].lat - a.lat) * ky;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        worst = Math.max(worst, Math.hypot(px - t * dx, py - t * dy));
      }
    }
    // The track spans a few km; 60 points must hold it to a small fraction of that.
    expect(worst).toBeLessThan(120);
  });
});

describe("buildRoutePreview", () => {
  it("is null when there is no line to draw", () => {
    expect(buildRoutePreview([], null)).toBeNull();
    expect(buildRoutePreview([{ lat: 32, lng: 35 }], null)).toBeNull();
  });

  it("caps at 60 points, rounds coordinates to 5 decimals and elevation to whole metres", () => {
    const line: LatLng[] = Array.from({ length: 900 }, (_, i) => ({
      lat: 32.123456789 + Math.sin(i / 30) * 0.01,
      lng: 35.987654321 + i * 0.00005,
    }));
    const ele = line.map((_, i) => 100.6 + i * 0.5);
    const preview = buildRoutePreview(line, ele);
    expect(preview).not.toBeNull();
    expect(preview?.points.length).toBeLessThanOrEqual(THUMB_POINT_TARGET);
    for (const [lat, lng] of preview?.points ?? []) {
      expect(Number.isInteger(Math.round(lat * 1e5))).toBe(true);
      expect(lat).toBe(Math.round(lat * 1e5) / 1e5);
      expect(lng).toBe(Math.round(lng * 1e5) / 1e5);
    }
    expect(preview?.elevations).toHaveLength(preview?.points.length ?? -1);
    expect(preview?.elevations?.[0]).toBe(101);
    expect((preview?.elevations ?? []).every((e) => Number.isInteger(e))).toBe(true);
  });

  it("omits the elevation series entirely when no point has one (the profile is then skipped)", () => {
    const preview = buildRoutePreview(lShape(50), null);
    expect(preview?.elevations).toBeUndefined();
    const nulls = buildRoutePreview(
      lShape(50),
      lShape(50).map(() => null),
    );
    expect(nulls?.elevations).toBeUndefined();
  });

  it("drops a non-finite point together with its elevation so the two stay aligned", () => {
    const line: LatLng[] = [
      { lat: 32, lng: 35 },
      { lat: Number.NaN, lng: 35.1 },
      { lat: 32.1, lng: 35.2 },
    ];
    const preview = buildRoutePreview(line, [10, 999, 30]);
    expect(preview?.points).toEqual([
      [32, 35],
      [32.1, 35.2],
    ]);
    expect(preview?.elevations).toEqual([10, 30]);
  });
});

describe("toStoredThumb / previewFromStored", () => {
  it("stores { p, e } and reads it back unchanged", () => {
    const preview = buildRoutePreview(
      lShape(300),
      lShape(300).map((_, i) => i),
    );
    const stored = toStoredThumb(preview);
    expect(stored).toEqual({ p: preview?.points, e: preview?.elevations });
    expect(previewFromStored(JSON.parse(JSON.stringify(stored)))).toEqual(preview);
  });

  it("stores nothing (null, not the JSON text 'null') when there is no preview", () => {
    expect(toStoredThumb(null)).toBeNull();
  });

  it("stores no `e` for a route without elevation", () => {
    expect(toStoredThumb(buildRoutePreview(lShape(20), null))).not.toHaveProperty("e");
  });

  it("derives a 60-point preview from an unbackfilled 300-point preview_points of tuples", () => {
    const tuples = lShape(150).map((p): [number, number] => [p.lat, p.lng]);
    const preview = previewFromStored(tuples);
    expect(preview?.points.length).toBeLessThanOrEqual(THUMB_POINT_TARGET);
    expect(preview?.elevations).toBeUndefined();
  });

  it("derives it from {lat, lng, ele} objects, carrying elevation along", () => {
    const objects = lShape(150).map((p, i) => ({ ...p, ele: 200 + i }));
    const preview = previewFromStored(objects);
    expect(preview?.elevations).toHaveLength(preview?.points.length ?? -1);
    expect(preview?.elevations?.[0]).toBe(200);
  });

  it("reads anything unusable as no preview", () => {
    for (const bad of [null, undefined, 7, "x", {}, { p: "nope" }, { p: [[1, 2]] }, [], [[1, 2]]]) {
      expect(previewFromStored(bad)).toBeNull();
    }
  });

  it("drops a misaligned elevation series rather than attributing it to the wrong points", () => {
    const preview = previewFromStored({
      p: [
        [32, 35],
        [32.1, 35.1],
      ],
      e: [1],
    });
    expect(preview).toEqual({
      points: [
        [32, 35],
        [32.1, 35.1],
      ],
    });
  });
});

describe("isMissingThumbColumn", () => {
  it("matches only a 42703 that names thumb_points", () => {
    const err = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(isMissingThumbColumn(err("42703", "column r.thumb_points does not exist"))).toBe(true);
    expect(isMissingThumbColumn(err("42703", 'column "season" does not exist'))).toBe(false);
    expect(isMissingThumbColumn(err("42P01", "relation thumb_points does not exist"))).toBe(false);
    expect(isMissingThumbColumn(null)).toBe(false);
  });
});
