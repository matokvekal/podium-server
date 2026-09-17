// The event:manage_link_group rule (sql/037).
//
// Connecting a ride to the organizer's other rides that day is a SHARING switch, not a ride
// detail, and the one property worth pinning is the one that is easy to "harmonise" away:
//
//   IT IS ALLOWED WHILE THE RIDE IS LIVE, AND event:edit IS NOT.
//
// That asymmetry looks like an oversight to anyone tidying policy.ts, so both halves are
// asserted here together. The most likely moment an organizer reaches for this is the morning
// of the day, with the long ride already rolling and latecomers asking which group to chase —
// exactly the state event:edit locks out, and exactly the state where the ride's own service
// already permits changing its sharing flags.

import { describe, expect, it } from "vitest";
import type { Event, EventStatus } from "../db/types.js";
import type { Actor, EventContext, EventRole, Participation } from "./policy.js";
import { canEvent } from "./policy.js";

/** canEvent reads only userId and entitlements off the actor for this capability. */
function actor(userId: number | null = 1): Actor {
  return {
    userId,
    globalRole: userId === null ? "guest" : "RIDER",
    entitlements: { features: new Set() },
  } as unknown as Actor;
}

function ctx(
  role: EventRole,
  status: EventStatus = "published",
  participation: Participation = "none",
): EventContext {
  return {
    event: { id: "e1", status, visibility: "public", showRoute: true } as unknown as Event,
    role,
    participation,
  };
}

describe("event:manage_link_group — who", () => {
  it("the owner may connect their rides", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("owner"))).toBe(true);
  });

  it("a co-organizer may too — isStaff everywhere else, so isStaff here", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("operator"))).toBe(true);
  });

  it("a viewer may not", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("viewer"))).toBe(false);
  });

  it("a rider on the start list may not — it is the organizer's link, not theirs", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx(null, "published", "approved"))).toBe(
      false,
    );
  });

  it("a guest may not", () => {
    expect(canEvent(actor(null), "event:manage_link_group", ctx(null))).toBe(false);
  });
});

describe("event:manage_link_group — when", () => {
  it("is ALLOWED while the ride is live", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("owner", "live"))).toBe(true);
  });

  it("⚠ and event:edit is NOT, while the ride is live — the two must not be harmonised", () => {
    expect(canEvent(actor(), "event:edit", ctx("owner", "live"))).toBe(false);
  });

  it("is refused once the ride has finished — nothing left to share", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("owner", "finished"))).toBe(false);
  });

  it("is refused on a cancelled ride", () => {
    expect(canEvent(actor(), "event:manage_link_group", ctx("owner", "cancelled"))).toBe(false);
  });

  it("is allowed in every pre-final status", () => {
    for (const status of ["draft", "published", "registration_open", "ready", "live"] as const) {
      expect(canEvent(actor(), "event:manage_link_group", ctx("owner", status))).toBe(true);
    }
  });
});
