import { describe, expect, it } from "vitest";
import { effectiveMaxParticipants, hasRoomForParticipants } from "./participant-capacity.js";

describe("effectiveMaxParticipants", () => {
  it("uses the owner's account cap when the ride has no override", () => {
    expect(effectiveMaxParticipants({ maxParticipants: null }, 50)).toBe(50);
    expect(effectiveMaxParticipants({}, 50)).toBe(50);
  });

  it("uses the admin's per-ride override when set, above or below the account cap", () => {
    expect(effectiveMaxParticipants({ maxParticipants: 30_000 }, 50)).toBe(30_000);
    expect(effectiveMaxParticipants({ maxParticipants: 3 }, 50)).toBe(3);
  });

  it("changes only the ceiling — the counting rule is the same", () => {
    const counts = { approved: 2, pending: 1 };
    expect(
      hasRoomForParticipants(counts, 1, effectiveMaxParticipants({ maxParticipants: 3 }, 50)),
    ).toBe(false);
    expect(
      hasRoomForParticipants(counts, 1, effectiveMaxParticipants({ maxParticipants: 4 }, 50)),
    ).toBe(true);
  });
});
