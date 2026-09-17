// Parsing the codes out of a /share/<codeA>-<codeB> link.
//
// This string is the one part of the feature that travels through the messy world: it gets
// pasted into WhatsApp, typed onto a poster, retyped by hand from a photo of a screen, and
// scanned out of a QR. Being lenient about the separator turns several dead links into
// working ones and costs nothing, because an event code is DDMMYYYY plus letters
// (sql/001-init.sql) and can never itself contain one.
//
// The cap is what stops a hand-written URL with fifty codes becoming fifty database lookups.

import { describe, expect, it } from "vitest";
import { linkGroupBodySchema, shareCodesParamSchema } from "./event.schemas.js";

function codes(value: string) {
  const result = shareCodesParamSchema.safeParse({ codes: value });
  return result.success ? result.data.codes : null;
}

describe("shareCodesParamSchema — the happy shapes", () => {
  it("splits the separator the client writes", () => {
    expect(codes("19092026A-19092026B")).toEqual(["19092026A", "19092026B"]);
  });

  it("takes a single code, so a group that shrank to one ride still resolves", () => {
    expect(codes("19092026A")).toEqual(["19092026A"]);
  });

  it("takes three", () => {
    expect(codes("19092026A-19092026B-19092026C")).toEqual(["19092026A", "19092026B", "19092026C"]);
  });

  it("accepts a comma or a plus too — what a person retypes by hand", () => {
    expect(codes("19092026A,19092026B")).toEqual(["19092026A", "19092026B"]);
    expect(codes("19092026A+19092026B")).toEqual(["19092026A", "19092026B"]);
  });

  it("upper-cases, the same way the join form does", () => {
    expect(codes("19092026a-19092026b")).toEqual(["19092026A", "19092026B"]);
  });

  it("survives a trailing separator instead of refusing the whole link", () => {
    expect(codes("19092026A-19092026B-")).toEqual(["19092026A", "19092026B"]);
  });

  it("survives stray whitespace from a copy-paste", () => {
    expect(codes(" 19092026A - 19092026B ")).toEqual(["19092026A", "19092026B"]);
  });
});

describe("shareCodesParamSchema — what it refuses", () => {
  it("refuses four codes, before they become four lookups", () => {
    expect(codes("A-B-C-D")).toBeNull();
  });

  it("refuses an empty string", () => {
    expect(codes("")).toBeNull();
  });

  it("refuses separators with nothing between them", () => {
    expect(codes("---")).toBeNull();
  });

  it("refuses a code longer than the column", () => {
    expect(codes(`${"A".repeat(33)}-19092026B`)).toBeNull();
  });

  it("refuses a URL-length string outright rather than splitting it", () => {
    expect(codes("A".repeat(200))).toBeNull();
  });
});

describe("linkGroupBodySchema", () => {
  it("takes the other rides' ids", () => {
    const parsed = linkGroupBodySchema.safeParse({
      eventIds: ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "b1ffcd88-8d1c-4fa9-aa7e-7cc8ce491b22"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.eventIds).toHaveLength(2);
  });

  it("defaults to an empty list, which the service reads as 'share this ride on its own'", () => {
    const parsed = linkGroupBodySchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.eventIds).toEqual([]);
  });

  it("caps at two — the anchor ride is implicit, so this is the 3-ride ceiling", () => {
    const parsed = linkGroupBodySchema.safeParse({
      eventIds: [
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "b1ffcd88-8d1c-4fa9-aa7e-7cc8ce491b22",
        "c2ee0e77-7e2d-4eba-b98f-8dd9df502c33",
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses anything that is not a uuid, so a code can never be sent here by mistake", () => {
    expect(linkGroupBodySchema.safeParse({ eventIds: ["19092026B"] }).success).toBe(false);
  });

  // Worth knowing while reading the rest of this file: zod's uuid() checks the version and
  // variant bits, so the all-1s placeholder that reads like a uuid is not one. Tests here use
  // real v4 values for that reason.
  it("refuses a uuid-shaped string with invalid version/variant bits", () => {
    expect(
      linkGroupBodySchema.safeParse({ eventIds: ["11111111-1111-1111-1111-111111111111"] }).success,
    ).toBe(false);
  });
});
