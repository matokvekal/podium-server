// route_difficulty / season / shade on the event schemas (sql/041): the value sets are exactly the
// ones observed in the curated MTB library, null clears, absent keeps, and a road ride is NOT
// refused (which disciplines offer these is a client product rule, like terrain_grade).

import { describe, expect, it } from "vitest";
import { createEventSchema, publicEventsQuerySchema, updateEventSchema } from "./event.schemas.js";

const base = { name: "Saturday MTB", startsAt: "2026-09-19T04:00:00.000Z" };

describe("create / update", () => {
  it("accepts every observed value", () => {
    for (const routeDifficulty of ["easy", "moderate", "hard", "challenging"]) {
      expect(createEventSchema.safeParse({ ...base, routeDifficulty }).success).toBe(true);
    }
    for (const season of ["all_year", "all_year_summer_ok", "winter_spring", "spring_autumn"]) {
      expect(createEventSchema.safeParse({ ...base, season }).success).toBe(true);
    }
    for (const shade of ["shaded", "partial", "exposed"]) {
      expect(createEventSchema.safeParse({ ...base, shade }).success).toBe(true);
    }
  });

  it("refuses values outside the vocabulary, including the Hebrew labels", () => {
    expect(createEventSchema.safeParse({ ...base, routeDifficulty: "קל" }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, season: "summer" }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, shade: "half" }).success).toBe(false);
  });

  it("null clears and an absent key stays undefined, on update", () => {
    const cleared = updateEventSchema.safeParse({
      routeDifficulty: null,
      season: null,
      shade: null,
    });
    expect(cleared.success).toBe(true);
    expect(cleared.data).toMatchObject({ routeDifficulty: null, season: null, shade: null });

    const untouched = updateEventSchema.parse({ name: "Renamed" });
    expect(untouched.routeDifficulty).toBeUndefined();
    expect(untouched.season).toBeUndefined();
    expect(untouched.shade).toBeUndefined();
  });

  it("does not refuse a road ride carrying them", () => {
    expect(
      createEventSchema.safeParse({ ...base, activityType: "road", shade: "shaded" }).success,
    ).toBe(true);
  });
});

describe("GET /events/public filters", () => {
  it("parses comma lists and drops unknown values", () => {
    const parsed = publicEventsQuerySchema.parse({
      routeDifficulty: "easy,hard,nonsense",
      season: "winter_spring",
      shade: "nonsense",
    });
    expect(parsed.routeDifficulty).toEqual(["easy", "hard"]);
    expect(parsed.season).toEqual(["winter_spring"]);
    expect(parsed.shade).toBeUndefined();
  });

  it("leaves them undefined when absent, so the list is unfiltered", () => {
    const parsed = publicEventsQuerySchema.parse({});
    expect(parsed.routeDifficulty).toBeUndefined();
    expect(parsed.season).toBeUndefined();
    expect(parsed.shade).toBeUndefined();
  });
});
