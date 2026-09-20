import { describe, expect, it } from "vitest";
import type { AutoCheckInConfig } from "../config/auto-check-in.js";
import { type AutoCheckInFacts, evaluateAutoCheckIn } from "./auto-check-in.js";

const CONFIG: AutoCheckInConfig = { radiusM: 100, windowMin: 60, maxAccuracyM: 100 };

const START = new Date("2026-09-20T05:30:00Z");
const START_POINT = { lat: 32.0, lng: 34.8 };

/** ~1 degree of latitude is 111.19 km, so this many metres north is this many degrees. */
function metresNorth(metres: number) {
  return { lat: START_POINT.lat + metres / 111_195, lng: START_POINT.lng };
}

function facts(overrides: Partial<AutoCheckInFacts> = {}): AutoCheckInFacts {
  return {
    autoCheckIn: true,
    status: "published",
    startsAt: START,
    startPoint: START_POINT,
    now: START,
    position: START_POINT,
    accuracyM: 10,
    ...overrides,
  };
}

describe("evaluateAutoCheckIn", () => {
  it("arrives when on the start point at the start time", () => {
    expect(evaluateAutoCheckIn(facts(), CONFIG)).toEqual({ decision: "arrived", distanceM: 0 });
  });

  it("arrives just inside the radius and reports the measured distance", () => {
    const result = evaluateAutoCheckIn(facts({ position: metresNorth(95) }), CONFIG);
    expect(result.decision).toBe("arrived");
    expect(result.distanceM).toBeGreaterThanOrEqual(94);
    expect(result.distanceM).toBeLessThanOrEqual(96);
  });

  it("is too_far just outside the radius, and says how far", () => {
    const result = evaluateAutoCheckIn(facts({ position: metresNorth(140) }), CONFIG);
    expect(result.decision).toBe("too_far");
    expect(result.distanceM).toBeGreaterThan(100);
  });

  it("honours a configured radius rather than a hard-coded one", () => {
    const wide = { ...CONFIG, radiusM: 300 };
    expect(evaluateAutoCheckIn(facts({ position: metresNorth(250) }), wide).decision).toBe(
      "arrived",
    );
    expect(evaluateAutoCheckIn(facts({ position: metresNorth(250) }), CONFIG).decision).toBe(
      "too_far",
    );
  });

  describe("time window", () => {
    it("accepts exactly the window edge, early and late", () => {
      const early = new Date(START.getTime() - 60 * 60_000);
      const late = new Date(START.getTime() + 60 * 60_000);
      expect(evaluateAutoCheckIn(facts({ now: early }), CONFIG).decision).toBe("arrived");
      expect(evaluateAutoCheckIn(facts({ now: late }), CONFIG).decision).toBe("arrived");
    });

    it("refuses a minute before the window opens and a minute after it closes", () => {
      const tooEarly = new Date(START.getTime() - 61 * 60_000);
      const tooLate = new Date(START.getTime() + 61 * 60_000);
      expect(evaluateAutoCheckIn(facts({ now: tooEarly }), CONFIG).decision).toBe("outside_window");
      expect(evaluateAutoCheckIn(facts({ now: tooLate }), CONFIG).decision).toBe("outside_window");
    });

    it("honours a configured window", () => {
      const now = new Date(START.getTime() - 90 * 60_000);
      expect(evaluateAutoCheckIn(facts({ now }), { ...CONFIG, windowMin: 120 }).decision).toBe(
        "arrived",
      );
      expect(evaluateAutoCheckIn(facts({ now }), CONFIG).decision).toBe("outside_window");
    });

    it("does not measure a distance for a request that is already out of window", () => {
      const now = new Date(START.getTime() + 5 * 60 * 60_000);
      expect(evaluateAutoCheckIn(facts({ now }), CONFIG)).toEqual({
        decision: "outside_window",
        distanceM: null,
      });
    });
  });

  describe("ride-level refusals", () => {
    it("is disabled when the organizer switched it off — even for a rider standing on the start", () => {
      expect(evaluateAutoCheckIn(facts({ autoCheckIn: false }), CONFIG)).toEqual({
        decision: "disabled",
        distanceM: null,
      });
    });

    it.each(["cancelled", "finished"])("is closed for a %s ride", (status) => {
      expect(evaluateAutoCheckIn(facts({ status }), CONFIG).decision).toBe("closed");
    });

    it.each(["published", "registration_open", "ready", "live"])(
      "accepts a ride whose status is %s",
      (status) => {
        expect(evaluateAutoCheckIn(facts({ status }), CONFIG).decision).toBe("arrived");
      },
    );

    it("has no start point without a route", () => {
      expect(evaluateAutoCheckIn(facts({ startPoint: null }), CONFIG).decision).toBe(
        "no_start_point",
      );
    });

    it("has no start point without a start time", () => {
      expect(evaluateAutoCheckIn(facts({ startsAt: null }), CONFIG).decision).toBe(
        "no_start_point",
      );
    });

    it("reports disabled before it reports a missing route", () => {
      expect(
        evaluateAutoCheckIn(facts({ autoCheckIn: false, startPoint: null }), CONFIG).decision,
      ).toBe("disabled");
    });
  });

  describe("GPS accuracy", () => {
    it("refuses a fix whose error circle is wider than the maximum, even when it lands on the start", () => {
      const result = evaluateAutoCheckIn(facts({ accuracyM: 500 }), CONFIG);
      expect(result.decision).toBe("inaccurate");
    });

    it("accepts a fix exactly at the maximum", () => {
      expect(evaluateAutoCheckIn(facts({ accuracyM: 100 }), CONFIG).decision).toBe("arrived");
    });

    it("accepts a fix that reports no accuracy at all", () => {
      expect(evaluateAutoCheckIn(facts({ accuracyM: undefined }), CONFIG).decision).toBe("arrived");
      expect(evaluateAutoCheckIn(facts({ accuracyM: null }), CONFIG).decision).toBe("arrived");
    });
  });
});
