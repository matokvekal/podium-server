// events.terrain_grade — how technical the ground is, 1-5 (sql/038).
//
// Three properties worth pinning:
//
//   1. THE RANGE IS THE WHOLE VALIDATION. 1-5 inclusive, integers only. The words (mtb S1-S5,
//      gravel G1-G5) are the client's, so nothing here should ever grow a discipline check.
//   2. null CLEARS, ABSENT KEEPS. Same contract as every other ride-plan field: an organizer
//      must be able to set the grade back to "not stated", and an edit that never mentions it
//      must not wipe it.
//   3. ⚠ A ROAD RIDE IS NOT REFUSED. Which disciplines OFFER a grade is a product rule the
//      client owns. Refusing it here would also mean an organizer who flips a ride between mtb
//      and road loses what they set — see the schema comment.

import { describe, expect, it } from "vitest";
import { createEventSchema, updateEventSchema } from "./event.schemas.js";

const base = { name: "Saturday MTB", startsAt: "2026-09-19T04:00:00.000Z" };

function create(terrainGrade: unknown) {
  return createEventSchema.safeParse({ ...base, terrainGrade });
}

describe("terrainGrade — the range", () => {
  it("accepts every grade from 1 to 5", () => {
    for (const grade of [1, 2, 3, 4, 5]) {
      const parsed = create(grade);
      expect(parsed.success, `grade ${grade}`).toBe(true);
      expect(parsed.data?.terrainGrade).toBe(grade);
    }
  });

  it("refuses 0 and 6 — the scale is exactly five wide", () => {
    expect(create(0).success).toBe(false);
    expect(create(6).success).toBe(false);
  });

  it("refuses a negative grade", () => {
    expect(create(-1).success).toBe(false);
  });

  it("refuses a fractional grade — S2.5 is not a thing on any trail sign", () => {
    expect(create(2.5).success).toBe(false);
  });

  it("refuses the label instead of the number, which is the likely client mistake", () => {
    expect(create("S3").success).toBe(false);
    expect(create("3").success).toBe(false);
  });
});

describe("terrainGrade — stated, cleared, untouched", () => {
  it("is optional on create: a ride with no grade is valid and stays undefined", () => {
    const parsed = createEventSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.terrainGrade).toBeUndefined();
  });

  it("accepts an explicit null on create — 'not stated', said out loud", () => {
    const parsed = create(null);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.terrainGrade).toBeNull();
  });

  it("null on update CLEARS it back to not-stated", () => {
    const parsed = updateEventSchema.safeParse({ terrainGrade: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.terrainGrade).toBeNull();
  });

  it("⚠ an absent key on update LEAVES IT ALONE — undefined, not null", () => {
    // updateEventRidePlan skips keys left undefined; this is the difference between
    // "the organizer cleared the grade" and "the organizer renamed the ride".
    const parsed = updateEventSchema.safeParse({ name: "New name" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.terrainGrade).toBeUndefined();
    expect("terrainGrade" in (parsed.data ?? {})).toBe(false);
  });
});

describe("terrainGrade — no discipline rule in the schema", () => {
  it("does not refuse a grade on a road ride", () => {
    const parsed = createEventSchema.safeParse({
      ...base,
      activityType: "road",
      terrainGrade: 3,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.terrainGrade).toBe(3);
  });

  it("does not require a grade on an mtb ride either — 'not stated' stays valid", () => {
    const parsed = createEventSchema.safeParse({ ...base, activityType: "mtb" });
    expect(parsed.success).toBe(true);
  });
});
