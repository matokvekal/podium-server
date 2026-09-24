// Cover for TURNING "REQUIRES APPROVAL" OFF — the other half of updateEventDetails
// (event.service.test.ts covers the visibility/publish half with the same harness).
//
// Before this, flipping requiresApproval only changed the flag: every rider already sitting in
// waiting_approval stayed there forever, since nothing ever re-touched their row. This service
// now bulk-approves them on that one transition. The properties worth protecting:
//
//   1. IT IS A TRANSITION, NOT A STATE. Only fires true -> false; a later PATCH of an
//      already-open event (or one that never mentions requiresApproval) must not re-run it.
//   2. ONLY waiting_approval MOVES. rejected stays rejected — turning approval off is not the
//      organizer un-rejecting anyone.
//   3. THE REVERSE DIRECTION WRITES NOTHING. false -> true leaves every existing rider exactly
//      as they were; only a fresh join from that point on lands in waiting_approval
//      (joinEvent's initialStatus, elsewhere in this file).
//
// No test database, so the queries layer is stubbed and the assertions are on what this service
// asks it to do — the same harness event.service.test.ts uses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEvent = vi.fn();
const approveAllWaitingParticipants = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));

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

vi.mock("../queries/participant.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/participant.queries.js")>(
    "../queries/participant.queries.js",
  );
  return {
    ...actual,
    approveAllWaitingParticipants: (...a: unknown[]) => approveAllWaitingParticipants(...a),
  };
});

const { updateEventDetails } = await import("./event.service.js");

const OWNER = 7;
const RIDE = {
  id: "e1",
  ownerId: OWNER,
  status: "published",
  visibility: "private",
  requiresApproval: true,
  name: "Sukkot night ride",
};

beforeEach(() => {
  selectEventById.mockReset().mockResolvedValue({ ...RIDE });
  updateEvent.mockReset().mockImplementation(async (_id: string, input: object) => ({
    ...RIDE,
    ...input,
  }));
  approveAllWaitingParticipants.mockReset().mockResolvedValue(3);
});

describe("ON -> OFF approves every rider still waiting", () => {
  it("bulk-approves on the transition, for the ride's owner", async () => {
    await updateEventDetails("e1", OWNER, { requiresApproval: false } as never);

    expect(approveAllWaitingParticipants).toHaveBeenCalledWith("e1");
  });

  it("still returns the updated ride when nobody was waiting", async () => {
    approveAllWaitingParticipants.mockResolvedValue(0);

    const updated = await updateEventDetails("e1", OWNER, { requiresApproval: false } as never);

    expect(updated.requiresApproval).toBe(false);
  });
});

describe("the guard against re-running it", () => {
  it("does NOT bulk-approve when the ride already had approval off", async () => {
    selectEventById.mockResolvedValue({ ...RIDE, requiresApproval: false });

    await updateEventDetails("e1", OWNER, {
      requiresApproval: false,
      description: "meet at the gate",
    } as never);

    expect(approveAllWaitingParticipants).not.toHaveBeenCalled();
  });

  it("does NOT bulk-approve on a PATCH that never mentions requiresApproval", async () => {
    await updateEventDetails("e1", OWNER, { description: "meet at the gate" } as never);

    expect(approveAllWaitingParticipants).not.toHaveBeenCalled();
  });
});

describe("OFF -> ON writes nothing to existing riders", () => {
  it("never calls the bulk approve when approval is turned ON", async () => {
    selectEventById.mockResolvedValue({ ...RIDE, requiresApproval: false });

    await updateEventDetails("e1", OWNER, { requiresApproval: true } as never);

    expect(approveAllWaitingParticipants).not.toHaveBeenCalled();
  });
});

describe("ownership still gates the edit itself", () => {
  it("rejects a stranger before anything is approved", async () => {
    await expect(
      updateEventDetails("e1", 999, { requiresApproval: false } as never),
    ).rejects.toMatchObject({ status: 403 });

    expect(approveAllWaitingParticipants).not.toHaveBeenCalled();
  });
});
