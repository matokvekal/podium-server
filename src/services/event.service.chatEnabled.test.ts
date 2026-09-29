// Per-event chat switch (sql/056) at the create/edit boundary: default ON, savable OFF/ON by the
// owner, independent of PROMOTE, and only the events row is written (messages are never touched).

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEvent = vi.fn();
const updateEventChatEnabled = vi.fn();
const updateEventPromoteOnly = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
    updateEventChatEnabled: (...a: unknown[]) => updateEventChatEnabled(...a),
    updateEventPromoteOnly: (...a: unknown[]) => updateEventPromoteOnly(...a),
  };
});

const { updateEventDetails } = await import("./event.service.js");
const { createEventSchema, updateEventSchema } = await import("../schemas/event.schemas.js");

const OWNER = 7;
const RIDE = {
  id: "e1",
  ownerId: OWNER,
  status: "published",
  visibility: "public",
  chatEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectEventById.mockResolvedValue(RIDE);
  updateEvent.mockResolvedValue(RIDE);
});

describe("edit: owner turns chat OFF and ON", () => {
  it("writes the flag both ways", async () => {
    await updateEventDetails("e1", OWNER, { chatEnabled: false });
    await updateEventDetails("e1", OWNER, { chatEnabled: true });
    expect(updateEventChatEnabled.mock.calls).toEqual([
      ["e1", false],
      ["e1", true],
    ]);
  });

  it("an edit that does not mention chat leaves it alone", async () => {
    await updateEventDetails("e1", OWNER, { name: "Renamed" });
    expect(updateEventChatEnabled).not.toHaveBeenCalled();
  });

  it("a non-owner cannot change it", async () => {
    await expect(updateEventDetails("e1", 999, { chatEnabled: false })).rejects.toMatchObject({
      status: 403,
    });
    expect(updateEventChatEnabled).not.toHaveBeenCalled();
  });

  it("is independent of PROMOTE: changing chat never writes PROMOTE", async () => {
    await updateEventDetails("e1", OWNER, { chatEnabled: false });
    expect(updateEventPromoteOnly).not.toHaveBeenCalled();
  });
});

describe("request schema", () => {
  const base = { name: "Ride", startsAt: "2026-10-01T04:00:00.000Z" };

  it("create: omitted => undefined (the server default is ON); false is accepted", () => {
    expect(createEventSchema.parse(base).chatEnabled).toBeUndefined();
    expect(createEventSchema.parse({ ...base, chatEnabled: false }).chatEnabled).toBe(false);
  });

  it("update: true / false accepted, omitted stays undefined, junk rejected", () => {
    expect(updateEventSchema.parse({ chatEnabled: true }).chatEnabled).toBe(true);
    expect(updateEventSchema.parse({ chatEnabled: false }).chatEnabled).toBe(false);
    expect(updateEventSchema.parse({}).chatEnabled).toBeUndefined();
    expect(updateEventSchema.safeParse({ chatEnabled: "no" }).success).toBe(false);
  });
});
