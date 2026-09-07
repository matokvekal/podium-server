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
