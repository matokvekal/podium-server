// The curated-MTB importer's pure logic: GPX reading, geometry-aware simplification, metadata
// normalization, derived values (corrected climb, popularity seeds) and the per-folder plan.
// No database: the runner's DB writes are exercised end to end against the local dev database.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ascentFromElevations,
  distanceToRegionKm,
  REGION_REVIEW_KM,
  SEED_MAX,
  SEED_MIN,
  seedCounts,
} from "./derive.js";
import { parseGpx } from "./gpx.js";
import { normalizeMtbMetadata, normalizeKey } from "./metadata.js";
import { planTrack, sourceKeyFor } from "./plan.js";
import {
  douglasPeuckerIndices,
  measureDeviation,
  previewLine,
  simplifyRoute,
} from "./simplify.js";

const pt = (lat: number, lng: number, ele: number | null = null) => ({ lat, lng, ele });

// ~0.00009 deg lat = 10 m
const M = 0.000009;

describe("parseGpx", () => {
  it("reads every <trk> and <trkseg> in document order and drops nothing", () => {
    const gpx = `<?xml version="1.0"?><gpx>
      <trk><trkseg>
        <trkpt lat="32.0" lon="35.0"><ele>10</ele></trkpt>
        <trkpt lat="32.001" lon="35.0"><ele>12</ele></trkpt>
      </trkseg><trkseg>
        <trkpt lat="32.002" lon="35.0"/>
      </trkseg></trk>
      <trk><trkseg><trkpt lat="33.0" lon="35.5"><ele>x</ele></trkpt><trkpt lat="33.1" lon="35.5"/></trkseg></trk>
    </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.points).toHaveLength(5);
    expect(parsed.parts.map((p) => [p.track, p.segment, p.count])).toEqual([
      [0, 0, 2],
      [0, 1, 1],
      [1, 0, 2],
    ]);
    // Elevation is only what the file said: missing or unreadable stays null, never 0.
    expect(parsed.points.map((p) => p.ele)).toEqual([10, 12, null, null, null]);
  });

  it("skips an invalid coordinate, strips a BOM, and falls back to <rte>", () => {
    const parsed = parseGpx(
      `﻿<gpx><rte><rtept lat="1" lon="2"/><rtept lat="999" lon="2"/><rtept lat="1.5" lon="2"/></rte></gpx>`,
    );
    expect(parsed.points).toHaveLength(2);
  });

  it("is order-independent for lat/lon attributes", () => {
    expect(parseGpx(`<gpx><trk><trkseg><trkpt lon="35" lat="32"/><trkpt lon="35" lat="32.1"/></trkseg></trk></gpx>`).points[0]).toMatchObject({ lat: 32, lng: 35 });
  });
});

describe("Douglas-Peucker simplification", () => {
  it("reduces a straight line to its two ends", () => {
    const line = Array.from({ length: 500 }, (_, i) => pt(32 + i * 0.0001, 35));
    expect(douglasPeuckerIndices(line, 8)).toEqual([0, 499]);
  });

  it("keeps a real corner", () => {
    const line = [
      ...Array.from({ length: 100 }, (_, i) => pt(32 + i * 0.0001, 35)),
      ...Array.from({ length: 100 }, (_, i) => pt(32.01, 35 + (i + 1) * 0.0001)),
    ];
    const kept = douglasPeuckerIndices(line, 8);
    expect(kept).toContain(99);
    expect(kept.length).toBeLessThan(6);
  });

  it("keeps more points on a winding section than on a straight one of the same length", () => {
    const straight = Array.from({ length: 200 }, (_, i) => pt(32 + i * 0.0001, 35));
    const winding = Array.from({ length: 200 }, (_, i) =>
      pt(32 + i * 0.0001, 35 + (i % 2 === 0 ? 0 : 40 * M)),
    );
    expect(douglasPeuckerIndices(winding, 8).length).toBeGreaterThan(
      douglasPeuckerIndices(straight, 8).length + 50,
    );
  });

  it("never lets any original point sit further than the tolerance from the result", () => {
    const wiggly = Array.from({ length: 800 }, (_, i) =>
      pt(32 + i * 0.00005 + Math.sin(i / 7) * 0.0002, 35 + Math.cos(i / 11) * 0.0003),
    );
    for (const tol of [5, 8, 10]) {
      const kept = douglasPeuckerIndices(wiggly, tol);
      const dev = measureDeviation(wiggly, kept, tol);
      expect(dev.maxM).toBeLessThanOrEqual(tol + 1e-6);
      expect(dev.withinToleranceShare).toBe(1);
      expect(kept.length).toBeLessThan(wiggly.length);
    }
  });

  it("copes with a closed loop (first point == last point) and tiny inputs", () => {
    const loop = [pt(32, 35), pt(32.001, 35), pt(32.001, 35.001), pt(32, 35.001), pt(32, 35)];
    expect(douglasPeuckerIndices(loop, 8)).toEqual([0, 1, 2, 3, 4]);
    expect(douglasPeuckerIndices([pt(1, 1), pt(2, 2)], 8)).toEqual([0, 1]);
  });

  it("carries elevation along on kept points", () => {
    const r = simplifyRoute([pt(32, 35, 100), pt(32.0005, 35, 130), pt(32.001, 35, 160)]);
    expect(r.points.map((p) => p.ele)).toEqual([100, 160]);
  });

  it("only relaxes the tolerance when the safety ceiling would be exceeded", () => {
    const zig = Array.from({ length: 400 }, (_, i) => pt(32 + i * 0.0001, 35 + (i % 2) * 60 * M));
    const normal = simplifyRoute(zig, { toleranceM: 8, ceilingPoints: 5000 });
    expect(normal.ceilingApplied).toBe(false);
    expect(normal.toleranceM).toBe(8);

    const capped = simplifyRoute(zig, { toleranceM: 8, ceilingPoints: 50 });
    expect(capped.ceilingApplied).toBe(true);
    expect(capped.points.length).toBeLessThanOrEqual(50);
    expect(capped.toleranceM).toBeGreaterThan(8);
  });

  it("previewLine fits a card-sized target", () => {
    const line = Array.from({ length: 2000 }, (_, i) =>
      pt(32 + i * 0.00002 + Math.sin(i / 5) * 0.0001, 35 + Math.cos(i / 9) * 0.0002),
    );
    expect(previewLine(line, 300).length).toBeLessThanOrEqual(300);
  });
});

describe("normalizeMtbMetadata", () => {
  const base = {
    name: "אגם בית זית – עמק הארזים",
    description: "תיאור",
    country: "IL",
    latitude: 31.78,
    longitude: 35.15,
    area: "ירושלים והרים",
    distance_km: 28,
    climb_m: 551,
    duration_hours: 4,
    difficulty: "בינוני",
    season: "אביב–סתיו",
    shade: "חלקית מוצל",
  };

  it("maps every value to its stable key and hours to minutes", () => {
    const r = normalizeMtbMetadata(base);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value).toMatchObject({
      routeDifficulty: "moderate",
      season: "spring_autumn",
      shade: "partial",
      region: "jerusalem",
      area: "ירושלים והרים",
      durationMin: 240,
      climbM: 551,
      distanceKm: 28,
      regionSource: "area",
    });
  });

  it("maps all four seasons by their actual meaning", () => {
    const season = (s: string) => {
      const r = normalizeMtbMetadata({ ...base, season: s });
      return r.ok ? r.value.season : r.errors;
    };
    expect(season("כל השנה")).toBe("all_year");
    expect(season("כל השנה (נעים בקיץ)")).toBe("all_year_summer_ok");
    expect(season("חורף–אביב")).toBe("winter_spring");
    expect(season("אביב–סתיו")).toBe("spring_autumn");
  });

  it("is tolerant of dash, slash and whitespace variants of an area", () => {
    expect(normalizeKey("כרמל  /  רמות מנשה")).toBe(normalizeKey("כרמל/רמות מנשה"));
    for (const area of ["כרמל / רמות מנשה", "כרמל/רמות מנשה", "  כרמל /  רמות  מנשה "]) {
      const r = normalizeMtbMetadata({ ...base, area });
      expect(r.ok && r.value.region).toBe("carmel");
    }
  });

  it("keeps the specific Hebrew area for every Negev spelling under the one negev key", () => {
    for (const area of ["נגב מערבי", "נגב / מכתשים", "נגב צפוני"]) {
      const r = normalizeMtbMetadata({ ...base, area });
      expect(r.ok && [r.value.region, r.value.area]).toEqual(["negev", area]);
    }
  });

  it("tolerates the old-format file: numbers as strings", () => {
    const r = normalizeMtbMetadata({ ...base, distance_km: "51", climb_m: "1000", duration_hours: "7" });
    expect(r.ok && [r.value.distanceKm, r.value.climbM, r.value.durationMin]).toEqual([51, 1000, 420]);
  });

  it("treats a negative climb as unknown, never stores it, and keeps the track", () => {
    const r = normalizeMtbMetadata({ ...base, climb_m: -108 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.climbM).toBeNull();
      expect(r.value.climbInvalid).toBe(true);
      expect(r.warnings.join()).toMatch(/negative/);
    }
  });

  it("errors, rather than guessing, on an unknown value", () => {
    for (const patch of [{ difficulty: "מטורף" }, { season: "קיץ" }, { shade: "ענן" }]) {
      expect(normalizeMtbMetadata({ ...base, ...patch }).ok).toBe(false);
    }
  });

  it("falls back to the coordinates only when the area is missing or unknown, and says so", () => {
    for (const area of ["", "מקום לא ידוע"]) {
      const r = normalizeMtbMetadata({ ...base, area, latitude: 32.75, longitude: 35.3 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.regionSource).toBe("coordinates");
        expect(r.value.region).toBe("lower_galilee");
        expect(r.warnings.join()).toMatch(/REVIEW/);
      }
    }
    // no coordinates -> nothing to fall back on
    expect(normalizeMtbMetadata({ ...base, area: "", latitude: null, longitude: null }).ok).toBe(false);
  });

  it("never overrides a KNOWN area from the coordinates", () => {
    const r = normalizeMtbMetadata({ ...base, area: "ערבה / אילת", latitude: 31.78, longitude: 35.15 });
    expect(r.ok && [r.value.region, r.value.regionSource]).toEqual(["arava", "area"]);
  });
});

describe("derived values", () => {
  it("computes positive ascent with the app's 5 m hysteresis, ignoring jitter", () => {
    const jitter = Array.from({ length: 40 }, (_, i) => 100 + (i % 2) * 2);
    expect(ascentFromElevations(jitter).ascentM).toBe(0);
    const climb = [...Array.from({ length: 12 }, (_, i) => 100 + i * 10), ...Array.from({ length: 12 }, (_, i) => 210 - i * 10)];
    const r = ascentFromElevations(climb);
    expect(r.ascentM).toBe(110);
  });

  it("is unknown (null) without reliable elevation — never 0, never negative", () => {
    expect(ascentFromElevations(Array(50).fill(null))).toEqual({ ascentM: null, reason: "no-elevation" });
    expect(ascentFromElevations([100, 110, 120]).ascentM).toBeNull();
    const sparse = Array.from({ length: 100 }, (_, i) => (i < 20 ? 100 + i * 3 : null));
    expect(ascentFromElevations(sparse).ascentM).toBeNull();
    for (const v of [ascentFromElevations([500, 400, 300, 200, 100, 0, 0, 0, 0, 0, 0]).ascentM]) {
      expect(v === null || v >= 0).toBe(true);
    }
  });

  it("measures how far a point is from its region and flags a real contradiction", () => {
    expect(distanceToRegionKm("jerusalem", 31.78, 35.2)).toBe(0);
    expect(distanceToRegionKm("center", 32.79, 34.96)).toBeGreaterThan(REGION_REVIEW_KM); // Haifa vs Center
    expect(distanceToRegionKm("atlantis", 1, 1)).toBeNull();
  });

  it("seeds are deterministic, in range, and independent of each other", () => {
    const a = seedCounts("mtb-singels:x");
    expect(seedCounts("mtb-singels:x")).toEqual(a);
    expect(a.likes).toBeGreaterThanOrEqual(SEED_MIN);
    expect(a.likes).toBeLessThanOrEqual(SEED_MAX);
    expect(a.downloads).toBeGreaterThanOrEqual(SEED_MIN);
    expect(a.downloads).toBeLessThanOrEqual(SEED_MAX);

    const many = Array.from({ length: 400 }, (_, i) => seedCounts(`mtb-singels:${i}`));
    expect(Math.min(...many.map((s) => s.likes))).toBe(SEED_MIN);
    expect(Math.max(...many.map((s) => s.likes))).toBe(SEED_MAX);
    expect(Math.min(...many.map((s) => s.downloads))).toBe(SEED_MIN);
    expect(Math.max(...many.map((s) => s.downloads))).toBe(SEED_MAX);
    // independent draws: likes are not simply equal to downloads
    expect(many.filter((s) => s.likes === s.downloads).length).toBeLessThan(40);
  });
});

describe("planTrack", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mtb-plan-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function makeFolder(name: string, gpx: string, meta: Record<string, unknown>) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta));
    writeFileSync(path.join(dir, `${name}.gpx`), gpx, "utf8");
    return dir;
  }
  const meta = {
    name: "מסלול",
    description: "d",
    country: "IL",
    latitude: 31.78,
    longitude: 35.15,
    area: "ירושלים והרים",
    distance_km: 10,
    climb_m: 100,
    duration_hours: 2,
    difficulty: "קל",
    season: "כל השנה",
    shade: "מוצל",
  };
  const trk = (n: number, withEle: boolean) =>
    `<?xml version="1.0"?><gpx><trk><trkseg>${Array.from({ length: n }, (_, i) => `<trkpt lat="${31.78 + i * 0.0001}" lon="35.15">${withEle ? `<ele>${400 + i * 2}</ele>` : ""}</trkpt>`).join("\n")}</trkseg></trk></gpx>`;

  it("plans a folder, leaving the original GPX byte-identical and hashing it", () => {
    const gpx = trk(300, true);
    makeFolder("plain", gpx, meta);
    const before = readFileSync(path.join(root, "plain", "plain.gpx"));

    const r = planTrack(root, "plain");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.gpxSha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(r.plan.gpxByteLength).toBe(before.length);
    expect(readFileSync(path.join(root, "plain", "plain.gpx")).equals(before)).toBe(true);
    expect(r.plan.sourceKey).toBe(sourceKeyFor("plain"));
    expect(r.plan.geometry.originalPoints).toBe(300);
    expect(r.plan.geometry.simplifiedPoints).toBeLessThan(10); // a straight line
    expect(r.plan.geometry.reductionPercent).toBeGreaterThan(90);
    expect(r.plan.climbSource).toBe("metadata");
    expect(r.plan.seedLikes).toBeGreaterThanOrEqual(0);
    expect(r.plan.seedLikes).toBeLessThanOrEqual(79);
    // elevation-bearing points are stored as objects, so the profile has somewhere to live
    expect(r.plan.trackPoints[0]).toMatchObject({ ele: 400 });
  });

  it("replaces a negative climb with the GPX ascent", () => {
    // 60 samples rising 2 m each (118 m in total). The app's 5 m hysteresis banks a climb in 6 m
    // steps (3 samples), so 19 whole steps count: 114 m — the same figure a hand upload reports.
    makeFolder("neg", trk(60, true), { ...meta, climb_m: -50 });
    const r = planTrack(root, "neg");
    expect(r.ok && [r.plan.climbSource, r.plan.climbM]).toEqual(["gpx", 114]);
  });

  it("stores the climb as unknown (null), not negative, when the GPX has no elevation", () => {
    makeFolder("noele", trk(60, false), { ...meta, climb_m: -50 });
    const r = planTrack(root, "noele");
    expect(r.ok && [r.plan.climbSource, r.plan.climbM]).toEqual(["unknown", null]);
    // no elevation at all -> plain [lat, lng] tuples, exactly as a route without elevation is stored
    expect(r.ok && Array.isArray(r.plan.trackPoints[0])).toBe(true);
  });

  it("flags a track whose coordinates contradict its area, without changing it", () => {
    makeFolder("far", trk(60, true), { ...meta, area: "מרכז / שפלה", latitude: 32.79, longitude: 34.96 });
    const r = planTrack(root, "far");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.metadata.area).toBe("מרכז / שפלה");
      expect(r.plan.metadata.region).toBe("center");
      expect(r.plan.reviewFlags.join()).toMatch(/km from region center/);
    }
  });

  it("fails one folder without touching the others", () => {
    makeFolder("bad", "<gpx></gpx>", meta);
    const r = planTrack(root, "bad");
    expect(r.ok).toBe(false);
    expect(planTrack(root, "nonexistent").ok).toBe(false);
  });

  it("keys the ledger by folder, so a rename cannot turn a track into a new one", () => {
    expect(sourceKeyFor("אגם-בית-זית")).toBe("mtb-singels:אגם-בית-זית");
    expect(sourceKeyFor("א".normalize("NFD"))).toBe(sourceKeyFor("א".normalize("NFC")));
  });
});
