// The description cap is the one event field whose limit the client also carries a copy of
// (elnino-client/src/lib/event-limits.ts), so the boundary is pinned here rather than left to
// agreement by inspection: at the cap, one over, and on BOTH schemas — an edit that the create
// form would refuse must not slip through PATCH.
//
// The rest is about what must NOT be rejected. Descriptions are stored as plain text, rendered
// as escaped React text children and written with parameterized SQL, so the safety of the field
// comes from length and type validation, not from filtering characters. Hebrew, Arabic, emoji,
// quotes and angle brackets are ordinary content for a ride plan, and a test that lets someone
// "harden" this into a blacklist later is the point of the last few cases.

import { describe, expect, it } from "vitest";
import { createEventSchema, DESCRIPTION_MAX_CHARS, updateEventSchema } from "./event.schemas.js";

const base = { name: "Saturday ride" };

describe("description length", () => {
  it("accepts a description of exactly the maximum length", () => {
    const result = createEventSchema.safeParse({
      ...base,
      description: "x".repeat(DESCRIPTION_MAX_CHARS),
    });

    expect(result.success).toBe(true);
    expect(result.data?.description).toHaveLength(DESCRIPTION_MAX_CHARS);
  });

  it("rejects one character over the maximum", () => {
    const result = createEventSchema.safeParse({
      ...base,
      description: "x".repeat(DESCRIPTION_MAX_CHARS + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["description"]);
  });

  it("rejects an over-long description on update too, not just on create", () => {
    const result = updateEventSchema.safeParse({
      description: "x".repeat(DESCRIPTION_MAX_CHARS + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["description"]);
  });

  it("counts characters, not bytes — a Hebrew description gets the full allowance", () => {
    const result = createEventSchema.safeParse({
      ...base,
      description: "א".repeat(DESCRIPTION_MAX_CHARS),
    });

    expect(result.success).toBe(true);
  });
});

describe("description whitespace", () => {
  it("trims before measuring, so trailing spaces cannot push a valid description over", () => {
    const result = createEventSchema.safeParse({
      ...base,
      description: `${"x".repeat(DESCRIPTION_MAX_CHARS)}     `,
    });

    expect(result.success).toBe(true);
    expect(result.data?.description).toHaveLength(DESCRIPTION_MAX_CHARS);
  });

  it("keeps the organizer's own line breaks — they are the structure of a ride plan", () => {
    const plan = "06:00 meet at the square\n06:30 roll out\n\nCoffee stop at 40km";
    const result = createEventSchema.safeParse({ ...base, description: `  ${plan}  ` });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe(plan);
  });

  it("collapses a whitespace-only description to empty, which the event page treats as absent", () => {
    const result = createEventSchema.safeParse({ ...base, description: "        " });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe("");
  });
});

describe("description content", () => {
  it("stays optional — creating a ride without one is normal", () => {
    const result = createEventSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.data?.description).toBeUndefined();
  });

  it("still accepts an empty string, unchanged from before", () => {
    const result = createEventSchema.safeParse({ ...base, description: "" });

    expect(result.success).toBe(true);
  });

  it("accepts Hebrew, Arabic, emoji, quotes, apostrophes and parentheses", () => {
    const real = 'יציאה 06:00 מ"הפארק" (50 ק"מ) 🚴 — نبدأ الساعة 6 — don\'t be late!';
    const result = createEventSchema.safeParse({ ...base, description: real });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe(real);
  });

  it("passes HTML-looking text through verbatim rather than stripping or refusing it", () => {
    // Angle brackets are not a threat to a field that is never interpreted as markup, and a rider
    // writing "<3" or "pace < 30kph" must not be told their description is invalid.
    const markupish = "<script>alert('x')</script> pace < 30kph & climbing > 1000m";
    const result = createEventSchema.safeParse({ ...base, description: markupish });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe(markupish);
  });

  it("rejects a non-string description rather than coercing it", () => {
    expect(createEventSchema.safeParse({ ...base, description: 42 }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, description: null }).success).toBe(false);
  });
});
