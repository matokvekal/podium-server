// Account-capability rules. The event/team resource rules are exercised through the services
// that call them; this file pins the standalone `canAccount` gate — in particular that ride
// creation is no longer free (it needs the `create_events` feature).

import { describe, expect, it } from "vitest";
import { ACCOUNT_CAPABILITIES, type Feature } from "./capabilities.js";
import type { Actor } from "./policy.js";
import { accountCapabilitiesFor, canAccount } from "./policy.js";

/** canAccount only reads userId and entitlements.features — a bare stub is all it needs. */
function actor(features: Feature[] = [], userId: number | null = 1): Actor {
  return {
    userId,
    globalRole: userId === null ? "guest" : "RIDER",
    entitlements: { features: new Set<Feature>(features) },
  } as unknown as Actor;
}

describe("canAccount — signed out", () => {
  it("refuses every account capability", () => {
    for (const cap of ACCOUNT_CAPABILITIES) {
      expect(canAccount(actor([], null), cap)).toBe(false);
    }
  });
});

describe("canAccount — the still-free capabilities", () => {
  it("team / route creation and publishing need only an identity", () => {
    const a = actor([]);
    expect(canAccount(a, "team:create")).toBe(true);
    expect(canAccount(a, "route:create")).toBe(true);
    expect(canAccount(a, "route:publish")).toBe(true);
  });
});

describe("canAccount — event:create is gated on the create_events feature", () => {
  it("a signed-in account without the feature may NOT create rides", () => {
    expect(canAccount(actor([]), "event:create")).toBe(false);
  });

  it("the feature (from a plan or a manual grant) unlocks it", () => {
    expect(canAccount(actor(["create_events"]), "event:create")).toBe(true);
  });
});

describe("canAccount — event:create_private needs BOTH features", () => {
  it("create_events alone is not enough", () => {
    expect(canAccount(actor(["create_events"]), "event:create_private")).toBe(false);
  });

  it("private_events alone is not enough — you cannot make a ride at all", () => {
    expect(canAccount(actor(["private_events"]), "event:create_private")).toBe(false);
  });

  it("both together unlock it", () => {
    expect(canAccount(actor(["create_events", "private_events"]), "event:create_private")).toBe(true);
  });
});

describe("accountCapabilitiesFor — what GET /users/me sends", () => {
  it("omits event:create (and event:create_private) for an ungranted account", () => {
    const caps = accountCapabilitiesFor(actor([]), ACCOUNT_CAPABILITIES);
    expect(caps).not.toContain("event:create");
    expect(caps).not.toContain("event:create_private");
    expect(caps).toContain("team:create");
  });

  it("includes event:create once the account is granted — the client's canOrganize", () => {
    const caps = accountCapabilitiesFor(actor(["create_events"]), ACCOUNT_CAPABILITIES);
    expect(caps).toContain("event:create");
  });
});
