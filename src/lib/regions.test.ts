import { describe, expect, it } from "vitest";
import { classifyRegion, IL_REGIONS, isRegionKey, REGION_KEYS } from "./regions.js";

describe("regions", () => {
  it("REGION_KEYS matches IL_REGIONS in order", () => {
    expect([...REGION_KEYS]).toEqual(IL_REGIONS.map((r) => r.key));
  });

  it("classifyRegion places well-known points", () => {
    // Tel Aviv
    expect(classifyRegion(32.08, 34.78)).toBe("center");
    // Jerusalem
    expect(classifyRegion(31.78, 35.22)).toBe("jerusalem");
    // Eilat — the tiny box beats the Arava band around it
    expect(classifyRegion(29.55, 34.95)).toBe("eilat");
    // Katzrin (Golan)
    expect(classifyRegion(32.99, 35.69)).toBe("golan");
  });

  it("the MTB sub-regions are keys, with their Hebrew labels", () => {
    const label = (key: string) => IL_REGIONS.find((r) => r.key === key)?.he;
    expect(label("upper_galilee")).toBe("גליל עליון");
    expect(label("lower_galilee")).toBe("גליל תחתון");
    expect(label("western_galilee")).toBe("גליל מערבי");
    expect(label("carmel")).toBe("כרמל / רמות מנשה");
    expect(label("gilboa_valleys")).toBe("גלבוע ועמקים");
    expect(label("south_hebron")).toBe("דרום הר חברון");
    // The Negev variants deliberately share the existing key.
    expect(REGION_KEYS.filter((k) => k.includes("negev"))).toEqual(["negev"]);
  });

  it("classifyRegion prefers the finer region when one contains the point", () => {
    expect(classifyRegion(32.75, 35.3)).toBe("lower_galilee"); // Nazareth area
    expect(classifyRegion(33.1, 35.45)).toBe("upper_galilee"); // Safed area
    expect(classifyRegion(32.65, 35.0)).toBe("carmel"); // Menashe heights
  });

  it("returns null outside every box", () => {
    expect(classifyRegion(48.85, 2.35)).toBeNull(); // Paris
    expect(classifyRegion(null, 35)).toBeNull();
    expect(classifyRegion(Number.NaN, 35)).toBeNull();
  });

  it("isRegionKey validates membership", () => {
    expect(isRegionKey("north")).toBe(true);
    expect(isRegionKey("atlantis")).toBe(false);
    expect(isRegionKey(42)).toBe(false);
  });
});
