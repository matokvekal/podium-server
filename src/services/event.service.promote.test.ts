// PROMOTE (sql/053) at the service layer: only the System Admin can change the flag, and a
// normal user cannot join a promoted event by calling the API directly.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const selectActiveEventByCode = vi.fn();
const updateEvent = vi.fn();
const updateEventPromoteOnly = vi.fn();
const selectUserEmails = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
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
