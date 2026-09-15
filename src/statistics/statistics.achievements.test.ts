import { describe, expect, it } from "vitest";
import { ACHIEVEMENT_TIERS, achievementProgress } from "./statistics.achievements.js";

describe("achievementProgress", () => {
  it("has no tier yet below the first threshold", () => {
    const result = achievementProgress("rides", 10);
    expect(result.current).toBeNull();
    expect(result.next).toEqual({ threshold: 25, name: "Stone" });
    expect(result.remaining).toBe(15);
  });

  it("computes progress as a percentage of the span between tiers", () => {
    // rides: Stone=25, Onyx=50 — 33 rides is 8/25 of the way from 25 to 50.
    const result = achievementProgress("rides", 33);
    expect(result.current).toEqual({ threshold: 25, name: "Stone" });
    expect(result.next).toEqual({ threshold: 50, name: "Onyx" });
    expect(result.progressPercent).toBe(Math.round((8 / 25) * 100));
    expect(result.remaining).toBe(17);
  });

  it("lands exactly on a threshold as 0% toward the NEXT tier, not 100% of the last", () => {
    const result = achievementProgress("rides", 50);
    expect(result.current).toEqual({ threshold: 50, name: "Onyx" });
    expect(result.next).toEqual({ threshold: 100, name: "Emerald" });
    expect(result.progressPercent).toBe(0);
  });

  it("reports every tier reached once the total clears the last threshold", () => {
    const last = ACHIEVEMENT_TIERS.rides[ACHIEVEMENT_TIERS.rides.length - 1];
    const result = achievementProgress("rides", last.threshold + 500);
    expect(result.current).toEqual(last);
    expect(result.next).toBeNull();
    expect(result.progressPercent).toBe(100);
    expect(result.remaining).toBe(0);
  });

  it("a total of exactly 0 has no current tier and targets the first one", () => {
    const result = achievementProgress("km", 0);
    expect(result.current).toBeNull();
    expect(result.next).toEqual(ACHIEVEMENT_TIERS.km[0]);
  });

  it("every category's tier list is strictly ascending — required by the scan-forward logic", () => {
    for (const tiers of Object.values(ACHIEVEMENT_TIERS)) {
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i].threshold).toBeGreaterThan(tiers[i - 1].threshold);
      }
    }
  });
});
