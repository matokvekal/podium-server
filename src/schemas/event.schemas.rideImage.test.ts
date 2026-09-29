// events.ride_image_key — the organizer's built-in ride cover photo (sql/051, sql/052).
//
// Two properties worth pinning:
//
//   1. THE SCHEMA ONLY ENFORCES A SAFE CHARSET — no path traversal, no URL, no arbitrary
//      string ever reaches the database. Whether the key is one the server actually PUBLISHES
//      (ride_images table, sql/052) is an async check that lives in services/event.service.ts
//      instead (see isKnownRideImageKey) — a Zod schema cannot query the database, and the
//      registry is no longer a compiled list a synchronous z.enum could check against.
//   2. null CLEARS, ABSENT KEEPS. Same contract as every other optional event field: an
//      organizer must be able to clear back to "no built-in image chosen", and an edit that
//      never mentions the field must not wipe it.

import { describe, expect, it } from "vitest";
import { createEventSchema, updateEventSchema } from "./event.schemas.js";

const base = { name: "Sukkot ride", startsAt: "2026-10-01T04:00:00.000Z" };

describe("rideImageKey — the charset", () => {
  it("accepts a static key, and an admin-uploaded key's shape", () => {
    for (const key of ["sukkot-01", "tikva1", "upload-1a2b3c4d5e6f7890"]) {
      const parsed = createEventSchema.safeParse({ ...base, rideImageKey: key });
      expect(parsed.success, `key ${key}`).toBe(true);
      expect(parsed.data?.rideImageKey).toBe(key);
    }
  });

  it("refuses a path/URL, not just an unusual key — the injection case", () => {
    for (const bad of [
      "../../etc/passwd",
      "https://evil.example/x.png",
      "/ride-images/x.webp",
      "sukkot/../01",
      "a".repeat(65),
      "",
      "Sukkot-01",
    ]) {
      const created = createEventSchema.safeParse({ ...base, rideImageKey: bad });
      expect(created.success, `key ${JSON.stringify(bad)}`).toBe(false);
      const updated = updateEventSchema.safeParse({ rideImageKey: bad });
      expect(updated.success, `key ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("rideImageKey — chosen, cleared, untouched", () => {
  it("is optional on create: a ride with no image is valid and stays undefined", () => {
    const parsed = createEventSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rideImageKey).toBeUndefined();
  });

  it("accepts an explicit null on create — 'no image chosen', said out loud", () => {
    const parsed = createEventSchema.safeParse({ ...base, rideImageKey: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rideImageKey).toBeNull();
  });

  it("null on update CLEARS it back to no image", () => {
    const parsed = updateEventSchema.safeParse({ rideImageKey: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rideImageKey).toBeNull();
  });

  it("⚠ an absent key on update LEAVES IT ALONE — undefined, not null", () => {
    // updateEventRideImage is only called when the caller passed the key at all; this is the
    // difference between "the organizer cleared the image" and "the organizer renamed the ride".
    const parsed = updateEventSchema.safeParse({ name: "New name" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.rideImageKey).toBeUndefined();
    expect("rideImageKey" in (parsed.data ?? {})).toBe(false);
  });
});
