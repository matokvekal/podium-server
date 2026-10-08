// POST /events must not leave a half-made ride behind (prod, 2026-10-08: a failing medal write
// left three "TEST MEDALS" rides with no medal, image or rider). createEvent removes the ride it
// just inserted when any follow-up write throws — and a ride with or without a medal still
// creates normally.

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertEvent = vi.fn();
const insertEventMember = vi.fn();
const updateEventMedalConfig = vi.fn();
const updateEventCountryRegion = vi.fn();
const updateEventElevationGain = vi.fn();
const upsertParticipant = vi.fn();
const deleteHalfCreatedEvent = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
vi.mock("../authz/actor.js", async () => ({
  ...(await vi.importActual<typeof import("../authz/actor.js")>("../authz/actor.js")),
  buildActor: async () => ({ userId: 7 }),
}));
vi.mock("../authz/policy.js", async () => ({
  ...(await vi.importActual<typeof import("../authz/policy.js")>("../authz/policy.js")),
  canAccount: () => true,
}));
vi.mock("../authz/limits.js", async () => ({
  ...(await vi.importActual<typeof import("../authz/limits.js")>("../authz/limits.js")),
  assertWithinEventsPerWeek: () => undefined,
}));
vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    countEventsCreatedSince: async () => 0,
    selectEventCodesWithPrefix: async () => [],
    insertEvent: (...a: unknown[]) => insertEvent(...a),
    insertEventMember: (...a: unknown[]) => insertEventMember(...a),
    updateEventMedalConfig: (...a: unknown[]) => updateEventMedalConfig(...a),
    updateEventCountryRegion: (...a: unknown[]) => updateEventCountryRegion(...a),
    updateEventElevationGain: (...a: unknown[]) => updateEventElevationGain(...a),
    upsertParticipant: (...a: unknown[]) => upsertParticipant(...a),
    deleteHalfCreatedEvent: (...a: unknown[]) => deleteHalfCreatedEvent(...a),
  };
});

const { createEvent } = await import("./event.service.js");

const base = {
  name: "TEST MEDALS",
  type: "RIDE",
  requiresBib: false,
  startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  displayMode: "standard",
  visibility: "public",
  requiresApproval: false,
  status: "published",
  elevationGainM: 99,
  joinAsRider: true,
} as unknown as Parameters<typeof createEvent>[1];

beforeEach(() => {
  for (const m of [
    insertEvent,
    insertEventMember,
    updateEventMedalConfig,
    updateEventCountryRegion,
    updateEventElevationGain,
    upsertParticipant,
    deleteHalfCreatedEvent,
  ])
    m.mockReset().mockResolvedValue(undefined);
  insertEvent.mockResolvedValue({ id: "new-ride", visibility: "public" });
});

describe("createEvent", () => {
  it("a ride with a medal: writes the medal config, keeps the ride", async () => {
    await expect(
      createEvent(7, {
        ...base,
        medalEnabled: true,
        medalText: "מדליית הוקרה",
        medalColorId: "sage",
        medalStyleId: "sunburst",
      }),
    ).resolves.toMatchObject({ id: "new-ride" });
    expect(updateEventMedalConfig).toHaveBeenCalledWith("new-ride", {
      medalEnabled: true,
      medalText: "מדליית הוקרה",
      medalColorId: "sage",
      medalStyleId: "sunburst",
    });
    expect(upsertParticipant).toHaveBeenCalled();
    expect(deleteHalfCreatedEvent).not.toHaveBeenCalled();
  });

  it("a normal ride: no medal write at all, ride kept", async () => {
    await expect(createEvent(7, base)).resolves.toMatchObject({ id: "new-ride" });
    expect(updateEventMedalConfig).not.toHaveBeenCalled();
    expect(deleteHalfCreatedEvent).not.toHaveBeenCalled();
  });

  it("a follow-up write that throws removes the half-made ride and returns the original error", async () => {
    const boom = new Error("bind message supplies 5 parameters, but prepared statement requires 2");
    updateEventMedalConfig.mockRejectedValue(boom);
    await expect(
      createEvent(7, { ...base, medalEnabled: true, medalText: "x" }),
    ).rejects.toBe(boom);
    expect(deleteHalfCreatedEvent).toHaveBeenCalledWith("new-ride");
    expect(upsertParticipant).not.toHaveBeenCalled();
  });

  it("if the clean-up itself fails, the caller still gets the ORIGINAL error", async () => {
    const boom = new Error("original");
    updateEventCountryRegion.mockRejectedValue(boom);
    deleteHalfCreatedEvent.mockRejectedValue(new Error("cleanup failed"));
    await expect(createEvent(7, base)).rejects.toBe(boom);
  });

  it("a refusal before the insert creates (and removes) nothing", async () => {
    await expect(
      createEvent(7, { ...base, startsAt: new Date("2020-01-01T00:00:00Z") }),
    ).rejects.toMatchObject({ status: 400 });
    expect(insertEvent).not.toHaveBeenCalled();
    expect(deleteHalfCreatedEvent).not.toHaveBeenCalled();
  });
});
