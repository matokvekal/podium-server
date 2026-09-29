// buildEventContext: how a participant row's left_at becomes the context the ride chat reads.
// The database is mocked (no Postgres); the mapping in actor.ts runs for real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../db/types.js";

const queryOne = vi.fn();
vi.mock("../db/pool.js", () => ({ queryOne: (...a: unknown[]) => queryOne(...a) }));
vi.mock("./entitlements.js", () => ({
  ANONYMOUS_ENTITLEMENTS: { features: new Set() },
  resolveEntitlements: vi.fn(),
}));

const { buildEventContext } = await import("./actor.js");

const event = { id: "e1", ownerId: 1 } as unknown as Event;

/** First queryOne call is event_members, the second is event_participants. */
function rows(member: unknown, participant: unknown) {
  queryOne.mockReset();
  queryOne.mockResolvedValueOnce(member).mockResolvedValueOnce(participant);
}

beforeEach(() => vi.clearAllMocks());

describe("buildEventContext — left_at", () => {
  it.each(["approved", "registered"])(
    "a %s rider with left_at set is role null, approved, hasLeft",
    async (status) => {
      rows(undefined, { registration_status: status, left_at: new Date() });
      await expect(buildEventContext(event, 7)).resolves.toMatchObject({
        role: null,
        participation: "approved",
        hasLeft: true,
      });
    },
  );

  it("an active approved rider is not hasLeft", async () => {
    rows(undefined, { registration_status: "approved", left_at: null });
    await expect(buildEventContext(event, 7)).resolves.toMatchObject({
      role: null,
      participation: "approved",
      hasLeft: false,
    });
  });

  it("hasLeft is only ever true for an approved participation", async () => {
    rows(undefined, { registration_status: "waiting_approval", left_at: new Date() });
    const ctx = await buildEventContext(event, 7);
    expect(ctx.participation).toBe("pending");
    expect(ctx.hasLeft).toBe(false);
  });

  it("the owner who also left keeps role owner", async () => {
    rows(undefined, { registration_status: "approved", left_at: new Date() });
    await expect(buildEventContext(event, 1)).resolves.toMatchObject({ role: "owner" });
  });
});
