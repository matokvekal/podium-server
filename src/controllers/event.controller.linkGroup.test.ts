// What the ride payload says about the other rides sharing its link (sql/037).
//
// The ride page's "1 of 2 rides that day · Switch ride" chip is built from `linkedRides`, so
// three things have to hold or the chip lies:
//
//   1. IT IS ABSENT-SHAPED, NOT MISSING. An ungrouped ride — almost every ride — sends `[]`, so
//      the client tests one thing and never has to distinguish "no siblings" from "old server".
//   2. IT NEVER CONTAINS THE RIDE ITSELF. A chip that counted its own ride would read "1 of 1".
//   3. IT IS THE FILTERED LIST, NOT THE RAW GROUP. Siblings the viewer may not see are removed
//      upstream (event.service.ts::getLinkedRidesForViewer); this mapper must pass through
//      exactly what it is given and add nothing back.
//
// Also pinned: `linkGroupId` rides along on the SUMMARY, which is what lets the organizer's
// "Created" list mark connected rides without a detail call per card.
//
// toEventDetail is a pure mapper; ../db/pool.js is stubbed only because importing the
// controller pulls it in transitively.

import { describe, expect, it, vi } from "vitest";

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const selectEventRouteSummary = vi.fn();
vi.mock("../queries/eventRoute.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/eventRoute.queries.js")>(
    "../queries/eventRoute.queries.js",
  );
  return {
    ...actual,
    selectEventRouteSummary: (...args: unknown[]) => selectEventRouteSummary(...args),
  };
});

const { toEventDetail, mapSharedRideCards } = await import("./event.controller.js");

const OWNER_ID = 7;

function ride(overrides: Record<string, unknown> = {}) {
  return {
    id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    code: "19092026A",
    name: "Long loop",
    type: "RIDE",
    ownerId: OWNER_ID,
    status: "published",
    visibility: "public",
    startsAt: new Date("2026-09-19T04:00:00Z"),
    endsAt: null,
    finishedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    requiresBib: false,
    requiresApproval: false,
    isPaused: false,
    isActive: true,
    description: null,
    location: null,
    area: null,
    linkGroupId: null,
    ...overrides,
  } as unknown as Parameters<typeof toEventDetail>[0];
}

const SHORT = ride({
  id: "b1ffcd88-8d1c-4fa9-aa7e-7cc8ce491b22",
  code: "19092026B",
  name: "Short loop",
  startsAt: new Date("2026-09-19T04:30:00Z"),
  linkGroupId: "g1",
});

function detail(event: ReturnType<typeof ride>, linked: ReturnType<typeof ride>[] = []) {
  return toEventDetail(event, OWNER_ID, null, "owner", null, null, null, true, null, true, linked);
}

describe("linkedRides on the ride payload", () => {
  it("is an empty array for a ride shared on its own — not undefined, not absent", () => {
    const payload = detail(ride());
    expect(payload.linkedRides).toEqual([]);
  });

  it("carries just enough per sibling to render a link and a label", () => {
    const payload = detail(ride({ linkGroupId: "g1" }), [SHORT]);

    expect(payload.linkedRides).toEqual([
      {
        eventId: "b1ffcd88-8d1c-4fa9-aa7e-7cc8ce491b22",
        code: "19092026B",
        name: "Short loop",
        startsAt: new Date("2026-09-19T04:30:00Z"),
      },
    ]);
  });

  it("passes through exactly what the service filtered, adding nothing back", () => {
    // The service hands over one sibling out of a group of three; the two it withheld are
    // withheld because this viewer may not see them.
    const payload = detail(ride({ linkGroupId: "g1" }), [SHORT]);
    expect(payload.linkedRides).toHaveLength(1);
  });

  it("never includes the ride itself", () => {
    const self = ride({ linkGroupId: "g1" });
    const payload = detail(self, [SHORT]);
    expect(payload.linkedRides.map((r) => r.eventId)).not.toContain(self.id);
  });

  it("does not leak a code through the redaction that hides when and where", () => {
    // A pending rider on a private ride gets no startsAt / location, but a sibling's code is
    // not a detail of THIS ride — it is the other ride's public join code, and the chip needs
    // it. The point of this test is that the two redactions stay independent.
    const payload = toEventDetail(
      ride({ linkGroupId: "g1", visibility: "private" }),
      999,
      null,
      "pending",
      null,
      null,
      null,
      false, // canSeeInfo
      null,
      false,
      [SHORT],
    );
    expect(payload.startsAt).toBeNull();
    expect(payload.linkedRides[0].code).toBe("19092026B");
  });
});

describe("linkGroupId on the summary half of the payload", () => {
  it("is null for a ride shared on its own", () => {
    expect(detail(ride()).linkGroupId).toBeNull();
  });

  it("is the group id once the ride is connected, so a list card can mark it", () => {
    expect(detail(ride({ linkGroupId: "g1" })).linkGroupId).toBe("g1");
  });

  it("reads as null on a database without sql/037, where the column is simply absent", () => {
    // mapEvent coalesces undefined -> null, but the mapper must not reintroduce undefined.
    expect(detail(ride({ linkGroupId: undefined })).linkGroupId).toBeNull();
  });
});

describe("the chooser's cards", () => {
  // The line travels WITH the group because GET /events/:id/route refuses a private ride to
  // the very reader a share link was sent to — three refusals, three spinners, no maps.
  const LINE = [
    [32.1, 34.8],
    [32.2, 34.9],
  ];

  function member(event: ReturnType<typeof ride>, canSeeInfo = true) {
    return { event, canSeeInfo } as unknown as Parameters<typeof mapSharedRideCards>[0][number];
  }

  it("carries the thinned preview line, not the full route", async () => {
    selectEventRouteSummary.mockResolvedValue({
      previewPoints: LINE,
      distanceKm: 120,
      elevationM: 1200,
    });

    const [card] = await mapSharedRideCards([member(ride())]);

    expect(card.route).toEqual({ points: LINE, distanceKm: 120, elevationM: 1200 });
  });

  it("⚠ gives no map to a member whose details this reader may not see", async () => {
    selectEventRouteSummary.mockClear();
    selectEventRouteSummary.mockResolvedValue({
      previewPoints: LINE,
      distanceKm: 120,
      elevationM: 1200,
    });

    const [card] = await mapSharedRideCards([member(ride(), false)]);

    expect(card.route).toBeNull();
    // Not even read: the redaction is decided before the query, so a card that must not show
    // a map cannot cost one either.
    expect(selectEventRouteSummary).not.toHaveBeenCalled();
  });

  it("is null for a ride with no track, and for a track stored without a preview line", async () => {
    selectEventRouteSummary.mockResolvedValueOnce(null);
    expect((await mapSharedRideCards([member(ride())]))[0].route).toBeNull();

    selectEventRouteSummary.mockResolvedValueOnce({
      previewPoints: null,
      distanceKm: 12,
      elevationM: null,
    });
    expect((await mapSharedRideCards([member(ride())]))[0].route).toBeNull();
  });

  it("⚠ normalises a line stored as {lat,lng} objects into the [lat,lng] wire form", async () => {
    // Preview lines exist in both shapes in this database. Handing the object form to a client
    // that projects tuples draws nothing, and draws it silently.
    selectEventRouteSummary.mockResolvedValue({
      previewPoints: [
        { lat: 32.1, lng: 34.8, ele: 40 },
        { lat: 32.2, lng: 34.9, ele: 55 },
      ],
      distanceKm: 120,
      elevationM: 1200,
    });

    const [card] = await mapSharedRideCards([member(ride())]);

    expect(card.route?.points).toEqual([
      [32.1, 34.8],
      [32.2, 34.9],
    ]);
  });
});
