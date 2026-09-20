// setAttendance's Statistics hook: once a ride has FINISHED, an organizer's tick or un-tick can
// change whether the ride counts for that rider (stats_require_live_checkin), so that one rider's
// numbers are refreshed at once. Before the finish nothing is needed — the finish hook computes
// everything. The refresh itself (and its flag check) is covered in statistics.service.test.ts;
// here it is stubbed and only WHEN it is called is asserted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = 1;
const RIDER_USER_ID = 42;
const EVENT_ID = "1ccab6f1-b2f6-4ede-bd2d-face92179797";

const getEventForViewer = vi.fn();
const updateAttendanceStatus = vi.fn();
const refreshStatsAfterAttendanceChange = vi.fn();

vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
  assertOwner: vi.fn(),
}));

vi.mock("../queries/participant.queries.js", () => ({
  updateAttendanceStatus: (...a: unknown[]) => updateAttendanceStatus(...a),
  // imported by the module under test, unused here
  deleteParticipant: vi.fn(),
  insertManualParticipant: vi.fn(),
  insertManualParticipants: vi.fn(),
  markArrivedAutomatically: vi.fn(),
  selectEventStartPoint: vi.fn(),
  selectParticipantByIdForEvent: vi.fn(),
  selectParticipantForEventUser: vi.fn(),
  selectParticipantsForEvent: vi.fn(),
  updateParticipant: vi.fn(),
  updateRegistrationStatus: vi.fn(),
  updateResult: vi.fn(),
}));

vi.mock("../statistics/statistics.service.js", () => ({
  refreshStatsAfterAttendanceChange: (...a: unknown[]) => refreshStatsAfterAttendanceChange(...a),
}));

const { setAttendance } = await import("./participant.service.js");

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    eventId: EVENT_ID,
    userId: RIDER_USER_ID,
    registrationStatus: "approved",
    attendanceStatus: "present",
    attendanceSource: "manual",
    ...overrides,
  };
}

beforeEach(() => {
  getEventForViewer.mockReset();
  updateAttendanceStatus.mockReset();
  refreshStatsAfterAttendanceChange.mockReset().mockResolvedValue(undefined);
});

describe("setAttendance — Statistics refresh", () => {
  it("refreshes the rider's statistics when the organizer marks them present after the finish", async () => {
    getEventForViewer.mockResolvedValue({ event: { id: EVENT_ID, status: "finished" } });
    updateAttendanceStatus.mockResolvedValue(participant({ attendanceStatus: "present" }));

    const result = await setAttendance(EVENT_ID, OWNER_ID, 2, "present");

    expect(result.attendanceStatus).toBe("present");
    expect(updateAttendanceStatus).toHaveBeenCalledWith(2, EVENT_ID, "present");
    expect(refreshStatsAfterAttendanceChange).toHaveBeenCalledWith(EVENT_ID, RIDER_USER_ID);
  });

  it("refreshes the rider's statistics when the organizer un-ticks them after the finish", async () => {
    getEventForViewer.mockResolvedValue({ event: { id: EVENT_ID, status: "finished" } });
    updateAttendanceStatus.mockResolvedValue(participant({ attendanceStatus: "unknown" }));

    await setAttendance(EVENT_ID, OWNER_ID, 2, "unknown");

    // Still the organizer's write (source stays 'manual' — that is what beats auto check-in).
    expect(updateAttendanceStatus).toHaveBeenCalledWith(2, EVENT_ID, "unknown");
    expect(refreshStatsAfterAttendanceChange).toHaveBeenCalledWith(EVENT_ID, RIDER_USER_ID);
  });

  it.each(["published", "registration_open", "ready", "live", "cancelled"])(
    "does not refresh anything while the ride is %s",
    async (status) => {
      getEventForViewer.mockResolvedValue({ event: { id: EVENT_ID, status } });
      updateAttendanceStatus.mockResolvedValue(participant());

      await setAttendance(EVENT_ID, OWNER_ID, 2, "present");

      expect(refreshStatsAfterAttendanceChange).not.toHaveBeenCalled();
    },
  );

  it("has no account to refresh for a manually added rider, and says nothing about it", async () => {
    getEventForViewer.mockResolvedValue({ event: { id: EVENT_ID, status: "finished" } });
    updateAttendanceStatus.mockResolvedValue(participant({ userId: null }));

    await expect(setAttendance(EVENT_ID, OWNER_ID, 2, "present")).resolves.toBeDefined();
    expect(refreshStatsAfterAttendanceChange).not.toHaveBeenCalled();
  });
});
