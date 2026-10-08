// PROMOTE (sql/053) at the service layer: only the System Admin can change the flag, and a
// normal user cannot join a promoted event by calling the API directly.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const selectActiveEventByCode = vi.fn();
const updateEvent = vi.fn();
const updateEventPromoteOnly = vi.fn();
const updateEventPromoteMessage = vi.fn();
const selectUserEmails = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
// A non-creator is checked against event_members for a manager role; here nobody is one.
vi.mock("../queries/eventManagers.queries.js", () => ({ selectEventMemberRole: async () => null }));
vi.mock("../queries/user.queries.js", () => ({
  selectUserEmails: (...a: unknown[]) => selectUserEmails(...a),
}));
vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    selectActiveEventByCode: (...a: unknown[]) => selectActiveEventByCode(...a),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
    updateEventPromoteOnly: (...a: unknown[]) => updateEventPromoteOnly(...a),
    updateEventPromoteMessage: (...a: unknown[]) => updateEventPromoteMessage(...a),
  };
});

const { joinEvent, updateEventDetails } = await import("./event.service.js");

const OWNER = 7;
const RIDE = {
  id: "e1",
  ownerId: OWNER,
  status: "published",
  visibility: "public",
  promoteOnly: false,
};

beforeEach(() => {
  for (const m of [
    selectEventById,
    selectActiveEventByCode,
    updateEvent,
    updateEventPromoteOnly,
    updateEventPromoteMessage,
    selectUserEmails,
  ])
    m.mockReset();
  selectEventById.mockResolvedValue(RIDE);
  updateEvent.mockResolvedValue(RIDE);
});

describe("updateEventDetails — promoteOnly", () => {
  it("refuses a non-admin owner sending promoteOnly (true AND false) and writes nothing", async () => {
    selectUserEmails.mockResolvedValue(["owner@example.com"]);
    for (const value of [true, false]) {
      await expect(updateEventDetails("e1", OWNER, { promoteOnly: value })).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(updateEvent).not.toHaveBeenCalled();
    expect(updateEventPromoteOnly).not.toHaveBeenCalled();
  });

  it("lets the System Admin turn it on and off", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    await updateEventDetails("e1", OWNER, { promoteOnly: true });
    await updateEventDetails("e1", OWNER, { promoteOnly: false });
    expect(updateEventPromoteOnly.mock.calls).toEqual([
      ["e1", true],
      ["e1", false],
    ]);
  });

  it("an ordinary edit without promoteOnly does no admin lookup and no promote write", async () => {
    await updateEventDetails("e1", OWNER, { name: "Renamed" });
    expect(selectUserEmails).not.toHaveBeenCalled();
    expect(updateEventPromoteOnly).not.toHaveBeenCalled();
  });
});

describe("joinEvent on a promoted event", () => {
  it("is refused with 403 for a normal user", async () => {
    selectActiveEventByCode.mockResolvedValue({ ...RIDE, promoteOnly: true, requiresBib: false });
    selectUserEmails.mockResolvedValue(["rider@example.com"]);
    await expect(joinEvent(99, "CODE", undefined)).rejects.toMatchObject({ status: 403 });
  });

  it("is refused for the System Admin too — registration is closed for everyone", async () => {
    selectActiveEventByCode.mockResolvedValue({ ...RIDE, promoteOnly: true, requiresBib: false });
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    await expect(joinEvent(1, "CODE", undefined)).rejects.toMatchObject({ status: 403 });
  });

  it("still gets past the PROMOTE check on a normal event (fails later, on 404-free path)", async () => {
    selectActiveEventByCode.mockResolvedValue({ ...RIDE, promoteOnly: false, requiresBib: true });
    // requiresBib with no bib is the next check after PROMOTE — proves PROMOTE did not stop it.
    await expect(joinEvent(99, "CODE", undefined)).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateEventDetails — PROMOTE registration message (sql/055)", () => {
  it("refuses a non-admin owner and writes nothing", async () => {
    selectUserEmails.mockResolvedValue(["owner@example.com"]);
    await expect(
      updateEventDetails("e1", OWNER, { promoteRegistrationMessage: "Call us" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateEvent).not.toHaveBeenCalled();
    expect(updateEventPromoteMessage).not.toHaveBeenCalled();
  });

  it("lets the System Admin save a custom message, and clear it back to the default (null)", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    await updateEventDetails("e1", OWNER, {
      promoteRegistrationMessage: "See https://example.com",
    });
    await updateEventDetails("e1", OWNER, { promoteRegistrationMessage: null });
    expect(updateEventPromoteMessage.mock.calls).toEqual([
      ["e1", "See https://example.com"],
      ["e1", null],
    ]);
  });

  it("turning PROMOTE off does not touch the saved message (it is kept for next time)", async () => {
    selectUserEmails.mockResolvedValue(["mictavim@gmail.com"]);
    await updateEventDetails("e1", OWNER, { promoteOnly: false });
    expect(updateEventPromoteOnly).toHaveBeenCalledWith("e1", false);
    expect(updateEventPromoteMessage).not.toHaveBeenCalled();
  });
});

describe("updateEventDetails — Organizer display name", () => {
  it("is a display edit by the owner: saved as given, ownership is never part of the update", async () => {
    await updateEventDetails("e1", OWNER, { organizerGroup: "Petah Tikva Municipality" });
    const [, patch] = updateEvent.mock.calls[0];
    expect(patch).toEqual({ organizerGroup: "Petah Tikva Municipality" });
    expect("ownerId" in patch).toBe(false);
    expect(selectUserEmails).not.toHaveBeenCalled(); // no admin needed, unlike PROMOTE
  });

  it("null clears it (back to the creator's own name)", async () => {
    await updateEventDetails("e1", OWNER, { organizerGroup: null });
    expect(updateEvent.mock.calls[0][1]).toEqual({ organizerGroup: null });
  });

  it("does not let a non-owner change it, whatever name they type", async () => {
    await expect(updateEventDetails("e1", 999, { organizerGroup: "Me now" })).rejects.toMatchObject(
      { status: 403 },
    );
    expect(updateEvent).not.toHaveBeenCalled();
  });
});

describe("joinEvent — the PROMOTE message never opens registration", () => {
  it("stays blocked with a custom message set", async () => {
    selectActiveEventByCode.mockResolvedValue({
      ...RIDE,
      promoteOnly: true,
      promoteRegistrationMessage: "Register at https://example.com",
      requiresBib: false,
    });
    await expect(joinEvent(99, "CODE", undefined)).rejects.toMatchObject({ status: 403 });
  });

  it("PROMOTE off restores the normal join path even though a message is still stored", async () => {
    selectActiveEventByCode.mockResolvedValue({
      ...RIDE,
      promoteOnly: false,
      promoteRegistrationMessage: "Register at https://example.com",
      requiresBib: true,
    });
    await expect(joinEvent(99, "CODE", undefined)).rejects.toMatchObject({ status: 400 });
  });
});
