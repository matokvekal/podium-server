import { describe, expect, it } from "vitest";
import { gemFor } from "./statistics.gems.js";
import {
  isPeriodCacheUsable,
  isPeriodFinal,
  isValidPeriod,
  nextPeriod,
  periodEnd,
  periodOf,
  periodsBetween,
  previousPeriod,
} from "./statistics.periods.js";

describe("period arithmetic (UTC calendar)", () => {
  it("keys a date by its UTC month and year", () => {
    expect(periodOf("month", new Date("2026-09-19T12:00:00Z"))).toBe("2026-09");
    expect(periodOf("year", new Date("2026-09-19T12:00:00Z"))).toBe("2026");
    // 23:30 UTC on 31 Aug is still August, whatever the server's local zone is.
    expect(periodOf("month", new Date("2026-08-31T23:30:00Z"))).toBe("2026-08");
  });

  it("steps across year boundaries in both directions", () => {
    expect(previousPeriod("month", "2026-01")).toBe("2025-12");
    expect(nextPeriod("month", "2025-12")).toBe("2026-01");
    expect(previousPeriod("year", "2026")).toBe("2025");
  });

  it("ends a period at the first instant of the next one", () => {
    expect(periodEnd("month", "2026-12").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(periodEnd("month", "2026-02").toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(periodEnd("year", "2026").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("lists periods newest-first with no gaps", () => {
    expect(periodsBetween("month", "2025-11", "2026-02")).toEqual([
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
    expect(periodsBetween("year", "2024", "2026")).toEqual(["2026", "2025", "2024"]);
  });

  it("validates the period shape per type", () => {
    expect(isValidPeriod("month", "2026-09")).toBe(true);
    expect(isValidPeriod("month", "2026-13")).toBe(false);
    expect(isValidPeriod("month", "2026")).toBe(false);
    expect(isValidPeriod("year", "2026")).toBe(true);
    expect(isValidPeriod("year", "2026-09")).toBe(false);
  });
});

describe("cache finality — current period is live 24h, a closed one is final once", () => {
  const now = new Date("2026-09-19T12:00:00Z");

  it("trusts the CURRENT month for 24h and then rebuilds it", () => {
    expect(isPeriodCacheUsable("month", "2026-09", new Date("2026-09-19T00:00:00Z"), now)).toBe(
      true,
    );
    expect(isPeriodCacheUsable("month", "2026-09", new Date("2026-09-18T11:00:00Z"), now)).toBe(
      false,
    );
  });

  it("keeps a row computed after its month closed, and rebuilds one computed before it closed", () => {
    // Computed in October, for a September that ended 1 Oct: final, forever.
    expect(
      isPeriodCacheUsable(
        "month",
        "2026-09",
        new Date("2026-10-05T00:00:00Z"),
        new Date("2027-05-01T00:00:00Z"),
      ),
    ).toBe(true);
    // Computed 31 Aug 22:00 for August, read in mid-September: computed BEFORE August closed, so
    // a ride finished in the last two hours could be missing — rebuilt once.
    expect(isPeriodCacheUsable("month", "2026-08", new Date("2026-08-31T22:00:00Z"), now)).toBe(
      false,
    );
  });

  it("does not call a month final in the hours after it closes — auto-finish can still back-date a ride into it", () => {
    // 1 Sept 12:00: August ended 12h ago. A ride that ended 31 Aug 23:00 is auto-finished (and
    // stamped 31 Aug) only ~24h later, so August is still open to change.
    const justClosed = new Date("2026-09-01T12:00:00Z");
    const computed = new Date("2026-09-01T03:00:00Z");
    expect(isPeriodFinal("month", "2026-08", computed, justClosed)).toBe(false);
    // Still served from the cache (it is fresh), just not promised as permanent.
    expect(isPeriodCacheUsable("month", "2026-08", computed, justClosed)).toBe(true);
    // Two days on, a row built after the settle window is final.
    expect(
      isPeriodFinal(
        "month",
        "2026-08",
        new Date("2026-09-03T00:00:00Z"),
        new Date("2026-09-04T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("reports a period final only when it is settled AND was computed after it settled", () => {
    expect(isPeriodFinal("month", "2026-09", new Date("2026-09-19T00:00:00Z"), now)).toBe(false);
    expect(isPeriodFinal("month", "2026-08", new Date("2026-09-05T00:00:00Z"), now)).toBe(true);
    expect(isPeriodFinal("month", "2026-08", new Date("2026-08-31T22:00:00Z"), now)).toBe(false);
    expect(isPeriodFinal("year", "2025", new Date("2026-01-05T00:00:00Z"), now)).toBe(true);
  });
});

describe("gems — thresholds differ per metric and per month-vs-year", () => {
  it("is Stone below the first threshold, including zero and an unmeasured (null) value", () => {
    expect(gemFor("month", "rides", 0)).toBe("stone");
    expect(gemFor("month", "rides", 1)).toBe("stone");
    expect(gemFor("month", "calories", null)).toBe("stone");
  });

  it("climbs the ladder at each boundary", () => {
    expect(gemFor("month", "rides", 2)).toBe("onyx");
    expect(gemFor("month", "rides", 5)).toBe("emerald");
    expect(gemFor("month", "rides", 10)).toBe("ruby");
    expect(gemFor("month", "rides", 15)).toBe("diamond");
    expect(gemFor("month", "rides", 400)).toBe("diamond");
  });

  it("holds a year to a higher bar than a month for the same number", () => {
    expect(gemFor("month", "rides", 15)).toBe("diamond");
    expect(gemFor("year", "rides", 15)).toBe("onyx");
  });
});
