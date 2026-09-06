// Cover for WHEN A RIDE PUBLISHES ITS TRACK — the visibility half of updateEventDetails.
//
// A track saved while the ride was private takes `is_public = FALSE` and nothing used to flip it
// back, so making the ride public left its track invisible in Find Tracks forever. This service
// now publishes it on the transition. The three properties worth protecting:
//
//   1. IT IS A TRANSITION, NOT A STATE. Firing on `input.visibility === "public"` alone would
//      re-publish on every later PATCH of an already-public ride — including one whose owner had
//      deliberately unlisted the track with PATCH /routes/:routeId { isPublic: false }.
//   2. GOING PRIVATE WRITES NOTHING. That direction is derived in selectPublicRoutes, which is
//      what makes it instant and reversible. A write here would be a second source of truth.
//   3. PUBLISHING MAY NEVER COST SOMEONE THEIR EDIT. The event update has already committed by
//      then, so a failure to publish must not turn a successful PATCH into an error.
//
// No test database, so the queries layer is stubbed and the assertions are on what this service
// asks it to do — the same harness eventRoute.service.test.ts uses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEvent = vi.fn();
const publishEventRouteIfOwned = vi.fn();

vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
  };
});

vi.mock("../queries/eventRoute.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/eventRoute.queries.js")>(
    "../queries/eventRoute.queries.js",
  );
  return {
    ...actual,
    publishEventRouteIfOwned: (...a: unknown[]) => publishEventRouteIfOwned(...a),
  };
});

const { updateEventDetails } = await import("./event.service.js");

const OWNER = 7;
const RIDE = {
  id: "e1",
  ownerId: OWNER,
  status: "published",
  visibility: "private",
  name: "Yom Kippur Jerusalem",
};

beforeEach(() => {
  selectEventById.mockReset().mockResolvedValue({ ...RIDE });
  updateEvent.mockReset().mockImplementation(async (_id: string, input: object) => ({
    ...RIDE,
    ...input,
  }));
  publishEventRouteIfOwned.mockReset().mockResolvedValue(1);
});

describe("PRIVATE -> PUBLIC publishes the ride's own track", () => {
  it("publishes on the transition, for the ride's owner", async () => {
    await updateEventDetails("e1", OWNER, { visibility: "public" } as never);

    expect(publishEventRouteIfOwned).toHaveBeenCalledWith("e1", OWNER);
  });

  it("does not wait for the ride's date — nothing here reads starts_at", async () => {
    // The whole point: a track is as rideable the week BEFORE the ride as the week after.
    // A future ride publishes its track the moment it goes public.
    selectEventById.mockResolvedValue({
      ...RIDE,
      startsAt: new Date("2099-01-01T00:00:00Z"),
    });

    await updateEventDetails("e1", OWNER, { visibility: "public" } as never);

    expect(publishEventRouteIfOwned).toHaveBeenCalledWith("e1", OWNER);
  });
});

describe("the guard against re-publishing", () => {
  it("does NOT publish when the ride was already public", async () => {
    // THE REGRESSION THIS GUARD EXISTS FOR. The owner unlisted the track by hand; an unrelated
    // PATCH (a new description, say) must not quietly put it back in Find Tracks.
    selectEventById.mockResolvedValue({ ...RIDE, visibility: "public" });

    await updateEventDetails("e1", OWNER, {
      visibility: "public",
      description: "meet at the gate",
    } as never);

    expect(publishEventRouteIfOwned).not.toHaveBeenCalled();
  });

  it("does NOT publish on a PATCH that never mentions visibility", async () => {
    await updateEventDetails("e1", OWNER, { description: "meet at the gate" } as never);

    expect(publishEventRouteIfOwned).not.toHaveBeenCalled();
  });
});

describe("PUBLIC -> PRIVATE is derived, never written", () => {
  it("writes nothing to the route when a ride goes private", async () => {
    // selectPublicRoutes drops it from Find Tracks on the next request. Unpublishing here too
    // would be a second source of truth, and would leave the track unlisted after a flip back.
    selectEventById.mockResolvedValue({ ...RIDE, visibility: "public" });

    await updateEventDetails("e1", OWNER, { visibility: "private" } as never);

    expect(publishEventRouteIfOwned).not.toHaveBeenCalled();
  });
});

describe("publishing is non-fatal", () => {
  it("still returns the updated ride when the track cannot be published", async () => {
    // The event row is already committed at this point. Throwing now would report a write that
    // really happened as a failure, and the client would show stale details.
    publishEventRouteIfOwned.mockRejectedValue(new Error("connection lost"));

    const updated = await updateEventDetails("e1", OWNER, { visibility: "public" } as never);

    expect(updated.visibility).toBe("public");
  });

  it("succeeds when the ride has no track at all", async () => {
    publishEventRouteIfOwned.mockResolvedValue(0);

    const updated = await updateEventDetails("e1", OWNER, { visibility: "public" } as never);

    expect(updated.visibility).toBe("public");
  });
});

describe("ownership still gates the edit itself", () => {
  it("rejects a stranger before anything is published", async () => {
    await expect(
      updateEventDetails("e1", 999, { visibility: "public" } as never),
    ).rejects.toMatchObject({ status: 403 });

    expect(publishEventRouteIfOwned).not.toHaveBeenCalled();
  });
});
