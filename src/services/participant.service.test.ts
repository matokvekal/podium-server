// Service-level cover for approve / reject. No test database in this repo, so the query layer
// and the event-view lookup are stubbed; what is exercised is setRegistrationStatus's control
// flow — owner gate, 404 on a missing row, and that the status handed to the DB is right.
//
// The SQL that broke in production (Postgres 42P18) is covered directly in
// queries/participant.queries.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const OWNER_ID = 1;
const EVENT_ID = "1ccab6f1-b2f6-4ede-bd2d-face92179797";

const getEventForViewer = vi.fn();
const selectParticipantByIdForEvent = vi.fn();
const updateRegistrationStatus = vi.fn();

vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
  // real ownership rule, inlined so the test does not depend on the module it is stubbing
  assertOwner: (event: { ownerId: number }, userId: number) => {
    if (event.ownerId !== userId) throw new ApiError(403, "Only the event owner may do this");
  },
}));

vi.mock("../queries/participant.queries.js", () => ({
  selectParticipantByIdForEvent: (...a: unknown[]) => selectParticipantByIdForEvent(...a),
  updateRegistrationStatus: (...a: unknown[]) => updateRegistrationStatus(...a),
  // unused by these tests but imported by the module under test
  deleteParticipant: vi.fn(),
  insertManualParticipant: vi.fn(),
  insertManualParticipants: vi.fn(),
  selectParticipantsForEvent: vi.fn(),
  updateAttendanceStatus: vi.fn(),
  updateParticipant: vi.fn(),
  updateResult: vi.fn(),
}));

const { approveParticipant, rejectParticipant } = await import("./participant.service.js");

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    eventId: EVENT_ID,
    userId: 42,
    name: "Rider Two",
    registrationStatus: "waiting_approval",
    attendanceStatus: "unknown",
    resultStatus: "none",
    ...overrides,
  };
}

beforeEach(() => {
  getEventForViewer.mockReset();
  selectParticipantByIdForEvent.mockReset();
  updateRegistrationStatus.mockReset();
  getEventForViewer.mockResolvedValue({ event: { id: EVENT_ID, ownerId: OWNER_ID } });
});

describe("approveParticipant", () => {
  it("owner approves a pending rider -> row comes back approved", async () => {
    selectParticipantByIdForEvent.mockResolvedValueOnce(participant());
    updateRegistrationStatus.mockResolvedValueOnce(participant({ registrationStatus: "approved" }));

    const result = await approveParticipant(EVENT_ID, OWNER_ID, 2);

    expect(result.registrationStatus).toBe("approved");
    expect(updateRegistrationStatus).toHaveBeenCalledWith(2, EVENT_ID, "approved");
  });

  it("approving a second rider is an independent call with that rider's id", async () => {
    selectParticipantByIdForEvent.mockResolvedValue(participant());
    updateRegistrationStatus.mockImplementation(async (id: number) =>
      participant({ id, registrationStatus: "approved" }),
    );

    await approveParticipant(EVENT_ID, OWNER_ID, 1);
    await approveParticipant(EVENT_ID, OWNER_ID, 2);

    expect(updateRegistrationStatus).toHaveBeenNthCalledWith(1, 1, EVENT_ID, "approved");
    expect(updateRegistrationStatus).toHaveBeenNthCalledWith(2, 2, EVENT_ID, "approved");
  });

  it("a non-owner is refused with 403 and never touches the DB", async () => {
    await expect(approveParticipant(EVENT_ID, 999, 2)).rejects.toMatchObject({ status: 403 });
    expect(selectParticipantByIdForEvent).not.toHaveBeenCalled();
    expect(updateRegistrationStatus).not.toHaveBeenCalled();
  });

  it("a participant id that is not on this event -> 404, no write", async () => {
    selectParticipantByIdForEvent.mockResolvedValueOnce(null);
    await expect(approveParticipant(EVENT_ID, OWNER_ID, 12345)).rejects.toMatchObject({
      status: 404,
    });
    expect(updateRegistrationStatus).not.toHaveBeenCalled();
  });
});

describe("rejectParticipant", () => {
  it("owner rejects a rider -> row comes back rejected, status passed through is 'rejected'", async () => {
    selectParticipantByIdForEvent.mockResolvedValueOnce(participant());
    updateRegistrationStatus.mockResolvedValueOnce(participant({ registrationStatus: "rejected" }));

    const result = await rejectParticipant(EVENT_ID, OWNER_ID, 2);

    expect(result.registrationStatus).toBe("rejected");
    expect(updateRegistrationStatus).toHaveBeenCalledWith(2, EVENT_ID, "rejected");
  });

  it("a non-owner cannot reject either", async () => {
    await expect(rejectParticipant(EVENT_ID, 999, 2)).rejects.toBeInstanceOf(ApiError);
    expect(updateRegistrationStatus).not.toHaveBeenCalled();
  });
});
