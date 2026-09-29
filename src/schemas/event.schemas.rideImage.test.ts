// events.ride_image_key — the organizer's built-in ride cover photo (sql/051).
//
// Two properties worth pinning:
//
//   1. ONLY A KEY THIS SERVER PUBLISHES SURVIVES. z.enum(RIDE_IMAGE_KEYS) — no path traversal,
//      no URL, no arbitrary string ever reaches the database (the "no upload" plan's whole
//      security argument rests on this).
//   2. null CLEARS, ABSENT KEEPS. Same contract as every other optional event field: an
//      organizer must be able to clear back to "no built-in image chosen", and an edit that
//      never mentions the field must not wipe it.

import { describe, expect, it } from "vitest";
import { RIDE_IMAGE_KEYS } from "../config/ride-images.js";
import { createEventSchema, updateEventSchema } from "./event.schemas.js";

const base = { name: "Sukkot ride", startsAt: "2026-10-01T04:00:00.000Z" };

describe("rideImageKey — the allow-list", () => {
  it("accepts every published key", () => {
    for (const key of RIDE_IMAGE_KEYS) {
      const parsed = createEventSchema.safeParse({ ...base, rideImageKey: key });
      expect(parsed.success, `key ${key}`).toBe(true);
      expect(parsed.data?.rideImageKey).toBe(key);
    }
  });

  it("refuses a key this server does not publish", () => {
    expect(createEventSchema.safeParse({ ...base, rideImageKey: "sukkot-99" }).success).toBe(
      false,
    );
    expect(updateEventSchema.safeParse({ rideImageKey: "sukkot-99" }).success).toBe(false);
  });

  it("refuses a path/URL, not just an unknown key — the injection case", () => {
    for (const bad of ["../../etc/passwd", "https://evil.example/x.png", "/ride-images/x.webp"]) {
      expect(createEventSchema.safeParse({ ...base, rideImageKey: bad }).success).toBe(false);
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
