// Ride stop points (sql/049): who may see and change them, validation, the per-ride cap, and the
// fail-soft read before the migration has run.
//
// The queries and the event lookup are mocked; the AUTHORIZATION RULES are not — canEvent from
// policy.ts runs for real, so these tests fail if "event:manage_stops" ever widens or narrows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, EventContext, EventRole, Participation } from "../authz/policy.js";
import type { Event } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";

const selectRideStops = vi.fn();
const insertRideStop = vi.fn();
const updateRideStop = vi.fn();
const deleteRideStop = vi.fn();
const getEventForViewer = vi.fn();
const canViewRoute = vi.fn();

vi.mock("../queries/rideStops.queries.js", () => ({
  selectRideStops: (...a: unknown[]) => selectRideStops(...a),
  insertRideStop: (...a: unknown[]) => insertRideStop(...a),
  updateRideStop: (...a: unknown[]) => updateRideStop(...a),
  deleteRideStop: (...a: unknown[]) => deleteRideStop(...a),
}));
vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
  canViewRoute: (...a: unknown[]) => canViewRoute(...a),
}));

const { listRideStops, addRideStop, editRideStop, removeRideStop } = await import(
  "./rideStops.service.js"
);
const { rideStopCreateSchema, rideStopUpdateSchema } = await import(
  "../schemas/rideStops.schemas.js"
);

const RIDE = "11111111-2222-3333-4444-555555555555";

function view(role: EventRole, participation: Participation, status = "open") {
  const event = { id: RIDE, ownerId: 1, visibility: "public", status } as unknown as Event;
  const actor = { userId: 7, globalRole: "RIDER", entitlements: { features: new Set() } };
  const context: EventContext = { event, role, participation };
  return { event, actor: actor as unknown as Actor, context, tier: "approved" };
}

function row(id: number, label = "קפה בדרך") {
  return {
    id: String(id),
    ride_id: RIDE,
    label,
    lat: 32.1,
    lng: 34.8,
    kind: "coffee",
    sort_order: id - 1,
    created_at: new Date("2026-09-24T06:00:00Z"),
    updated_at: new Date("2026-09-24T06:00:00Z"),
  };
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
}

beforeEach(() => {
  vi.clearAllMocks();
  canViewRoute.mockReturnValue(true);
});

describe("reading", () => {
  it("a rider sees the stops, read-only", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    selectRideStops.mockResolvedValue([row(1), row(2, "Water")]);

    const result = await listRideStops(RIDE, 7);

    expect(result.canManage).toBe(false);
    expect(result.limits.maxStops).toBe(5);
    expect(result.stops.map((s) => s.label)).toEqual(["קפה בדרך", "Water"]);
    expect(result.stops[0]).toMatchObject({ id: 1, rideId: RIDE, lat: 32.1, lng: 34.8 });
  });

  it("the creator gets canManage", async () => {
    getEventForViewer.mockResolvedValue(view("owner", "none"));
    selectRideStops.mockResolvedValue([]);
    await expect(listRideStops(RIDE, 1)).resolves.toMatchObject({ canManage: true, stops: [] });
  });

  it("someone who may not see the route gets no stops (and no query runs)", async () => {
    getEventForViewer.mockResolvedValue(view(null, "none"));
    canViewRoute.mockReturnValue(false);
    await expect(listRideStops(RIDE, null)).resolves.toMatchObject({ stops: [] });
    expect(selectRideStops).not.toHaveBeenCalled();
  });

  it("before sql/049 has run (42P01) it answers 'no stops' and offers no editor", async () => {
    getEventForViewer.mockResolvedValue(view("owner", "none"));
    selectRideStops.mockRejectedValue(Object.assign(new Error("no table"), { code: "42P01" }));
    await expect(listRideStops(RIDE, 1)).resolves.toMatchObject({ stops: [], canManage: false });
  });

  it("any other database error is NOT swallowed", async () => {
    getEventForViewer.mockResolvedValue(view("owner", "none"));
    selectRideStops.mockRejectedValue(Object.assign(new Error("boom"), { code: "57P01" }));
    await expect(listRideStops(RIDE, 1)).rejects.toThrow("boom");
  });

  it("an unknown kind from the database reads as coffee", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    selectRideStops.mockResolvedValue([{ ...row(1), kind: "spaceship" }]);
    const { stops } = await listRideStops(RIDE, 7);
    expect(stops[0].kind).toBe("coffee");
  });
});

describe("who may change stops", () => {
  const input = { label: "Coffee", lat: 32, lng: 34.9 };

  it("the creator may add one, on an open ride and on a live one", async () => {
    for (const status of ["open", "live"]) {
      getEventForViewer.mockResolvedValue(view("owner", "none", status));
      insertRideStop.mockResolvedValue({ kind: "ok", row: row(1, "Coffee") });
      await expect(addRideStop(RIDE, 1, input)).resolves.toMatchObject({ label: "Coffee" });
    }
  });

  it("a co-organizer (operator) may NOT — creator only", async () => {
    getEventForViewer.mockResolvedValue(view("operator", "none"));
    await expectStatus(addRideStop(RIDE, 7, input), 403);
    expect(insertRideStop).not.toHaveBeenCalled();
  });

  it("a rider may not add, move or delete", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    await expectStatus(addRideStop(RIDE, 7, input), 403);
    await expectStatus(editRideStop(RIDE, 1, 7, { lat: 1, lng: 1 }), 403);
    await expectStatus(removeRideStop(RIDE, 1, 7), 403);
    expect(updateRideStop).not.toHaveBeenCalled();
    expect(deleteRideStop).not.toHaveBeenCalled();
  });

  it("nobody may change stops once the ride is finished or cancelled", async () => {
    for (const status of ["finished", "cancelled"]) {
      getEventForViewer.mockResolvedValue(view("owner", "none", status));
      await expectStatus(addRideStop(RIDE, 1, input), 403);
    }
  });
});

describe("validation and limits", () => {
  beforeEach(() => {
    getEventForViewer.mockResolvedValue(view("owner", "none"));
  });

  it("the label is trimmed and whitespace collapsed; blank is refused", async () => {
    insertRideStop.mockResolvedValue({ kind: "ok", row: row(1, "Café Nitza") });
    await addRideStop(RIDE, 1, { label: "  Café   Nitza ", lat: 32, lng: 34 });
    expect(insertRideStop.mock.calls[0][2]).toMatchObject({ label: "Café Nitza", kind: "coffee" });

    await expectStatus(addRideStop(RIDE, 1, { label: "   ", lat: 32, lng: 34 }), 400);
  });

  it("a label over 120 characters is refused", async () => {
    await expectStatus(addRideStop(RIDE, 1, { label: "x".repeat(121), lat: 32, lng: 34 }), 400);
  });

  it("the 6th stop is refused with 409 (cap passed to the query is 5)", async () => {
    insertRideStop.mockResolvedValue({ kind: "limit" });
    await expectStatus(addRideStop(RIDE, 1, { label: "One more", lat: 32, lng: 34 }), 409);
    expect(insertRideStop.mock.calls[0][3]).toBe(5);
  });

  it("a stop id that is not on this ride is 404 for edit and delete", async () => {
    updateRideStop.mockResolvedValue(null);
    deleteRideStop.mockResolvedValue(false);
    await expectStatus(editRideStop(RIDE, 99, 1, { label: "x" }), 404);
    await expectStatus(removeRideStop(RIDE, 99, 1), 404);
  });

  it("a drag sends only the new position", async () => {
    updateRideStop.mockResolvedValue(row(1));
    await editRideStop(RIDE, 1, 1, { lat: 32.5, lng: 35 });
    expect(updateRideStop).toHaveBeenCalledWith(RIDE, 1, {
      lat: 32.5,
      lng: 35,
      label: undefined,
    });
  });
});

describe("request schemas", () => {
  it("rejects coordinates out of range and unknown kinds", () => {
    expect(rideStopCreateSchema.safeParse({ label: "a", lat: 91, lng: 0 }).success).toBe(false);
    expect(rideStopCreateSchema.safeParse({ label: "a", lat: 0, lng: 181 }).success).toBe(false);
    expect(rideStopCreateSchema.safeParse({ label: "a", lat: 0, lng: 0, kind: "x" }).success).toBe(
      false,
    );
    expect(rideStopCreateSchema.safeParse({ label: "a", lat: 0, lng: 0 }).success).toBe(true);
  });

  it("lat and lng must move together", () => {
    expect(rideStopUpdateSchema.safeParse({ lat: 1 }).success).toBe(false);
    expect(rideStopUpdateSchema.safeParse({ lat: 1, lng: 2 }).success).toBe(true);
    expect(rideStopUpdateSchema.safeParse({ label: "x" }).success).toBe(true);
  });

  it("strips fields the client does not own", () => {
    const parsed = rideStopCreateSchema.parse({ label: "a", lat: 0, lng: 0, created_by: 99 });
    expect(parsed).not.toHaveProperty("created_by");
  });
});
