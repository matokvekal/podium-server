// Service-level cover for autoCheckIn. The distance / time-window / accuracy arithmetic is
// covered exhaustively in lib/auto-check-in.test.ts; what is exercised HERE is the service's own
// contract: who may check in, what is never overwritten, and that the write only happens on a
// genuine "arrived". The query layer and the event-view lookup are stubbed (no test database).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const OWNER_ID = 1;
const RIDER_ID = 42;
const EVENT_ID = "1ccab6f1-b2f6-4ede-bd2d-face92179797";

const getEventForViewer = vi.fn();
const selectParticipantForEventUser = vi.fn();
const markArrivedAutomatically = vi.fn();
const selectEventStartPoint = vi.fn();

vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
  assertOwner: vi.fn(),
}));

vi.mock("../queries/participant.queries.js", () => ({
  selectParticipantForEventUser: (...a: unknown[]) => selectParticipantForEventUser(...a),
  markArrivedAutomatically: (...a: unknown[]) => markArrivedAutomatically(...a),
  selectEventStartPoint: (...a: unknown[]) => selectEventStartPoint(...a),
  // imported by the module under test, unused here
  deleteParticipant: vi.fn(),
  insertManualParticipant: vi.fn(),
  insertManualParticipants: vi.fn(),
  selectParticipantByIdForEvent: vi.fn(),
  selectParticipantsForEvent: vi.fn(),
  updateAttendanceStatus: vi.fn(),
  updateParticipant: vi.fn(),
  updateRegistrationStatus: vi.fn(),
  updateResult: vi.fn(),
}));

const { autoCheckIn } = await import("./participant.service.js");

const START_POINT = { lat: 32.0, lng: 34.8 };
const HERE = { position: { lat: 32.0, lng: 34.8 }, accuracyM: 10 };
// ~5.5 km north of the start point.
const FAR = { position: { lat: 32.05, lng: 34.8 }, accuracyM: 10 };

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    eventId: EVENT_ID,
    userId: RIDER_ID,
    name: "Rider Two",
    registrationStatus: "approved",
    attendanceStatus: "unknown",
    attendanceSource: null,
    leftAt: null,
    resultStatus: "none",
    ...overrides,
  };
}

function rideStartingNow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    ownerId: OWNER_ID,
    autoCheckIn: true,
    status: "published",
    startsAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  getEventForViewer.mockReset();
  selectParticipantForEventUser.mockReset();
  markArrivedAutomatically.mockReset();
  selectEventStartPoint.mockReset();

  getEventForViewer.mockResolvedValue({ event: rideStartingNow() });
  selectEventStartPoint.mockResolvedValue(START_POINT);
  selectParticipantForEventUser.mockResolvedValue(participant());
});

describe("autoCheckIn", () => {
  it("marks an approved rider on the start line, at start time, as arrived", async () => {
    markArrivedAutomatically.mockResolvedValueOnce(
      participant({ attendanceStatus: "present", attendanceSource: "auto" }),
    );

    const result = await autoCheckIn(EVENT_ID, RIDER_ID, HERE);

    expect(result.outcome).toBe("arrived");
    expect(result.participant.attendanceSource).toBe("auto");
    expect(markArrivedAutomatically).toHaveBeenCalledWith(2, EVENT_ID);
  });

  it("a rider on a `registered` (no-approval) ride may check in too", async () => {
    selectParticipantForEventUser.mockResolvedValue(
      participant({ registrationStatus: "registered" }),
    );
    markArrivedAutomatically.mockResolvedValueOnce(participant({ attendanceStatus: "present" }));

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("arrived");
  });

  it("does not write when the rider is too far away, and says how far", async () => {
    const result = await autoCheckIn(EVENT_ID, RIDER_ID, FAR);

    expect(result.outcome).toBe("too_far");
    expect(result.distanceM).toBeGreaterThan(100);
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("does not write when the ride is nowhere near its start time", async () => {
    getEventForViewer.mockResolvedValue({
      event: rideStartingNow({ startsAt: new Date(Date.now() + 5 * 60 * 60_000) }),
    });

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("outside_window");
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("does not write, and never reads the route, when the organizer switched it off", async () => {
    getEventForViewer.mockResolvedValue({ event: rideStartingNow({ autoCheckIn: false }) });

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("disabled");
    expect(selectEventStartPoint).not.toHaveBeenCalled();
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("a ride with no route has no start point to be near", async () => {
    selectEventStartPoint.mockResolvedValue(null);

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("no_start_point");
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("a rider still waiting for approval is not checked in, however close they are", async () => {
    selectParticipantForEventUser.mockResolvedValue(
      participant({ registrationStatus: "waiting_approval" }),
    );

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("not_approved");
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("a rejected rider is not checked in", async () => {
    selectParticipantForEventUser.mockResolvedValue(
      participant({ registrationStatus: "rejected" }),
    );

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("not_approved");
  });

  it("a rider who has left the ride is not checked in", async () => {
    selectParticipantForEventUser.mockResolvedValue(participant({ leftAt: new Date() }));

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("not_approved");
  });

  it("someone with no row on the ride at all is refused with 403", async () => {
    selectParticipantForEventUser.mockResolvedValue(null);

    await expect(autoCheckIn(EVENT_ID, OWNER_ID, HERE)).rejects.toMatchObject({ status: 403 });
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("an already-present rider is left exactly as they are, and the route is not even read", async () => {
    selectParticipantForEventUser.mockResolvedValue(
      participant({ attendanceStatus: "present", attendanceSource: "manual" }),
    );

    const result = await autoCheckIn(EVENT_ID, RIDER_ID, HERE);

    expect(result.outcome).toBe("already_recorded");
    expect(result.participant.attendanceSource).toBe("manual");
    expect(selectEventStartPoint).not.toHaveBeenCalled();
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("a rider the organizer un-ticked stays un-ticked (unknown + a manual source)", async () => {
    selectParticipantForEventUser.mockResolvedValue(
      participant({ attendanceStatus: "unknown", attendanceSource: "manual" }),
    );

    expect((await autoCheckIn(EVENT_ID, RIDER_ID, HERE)).outcome).toBe("organizer_decided");
    expect(markArrivedAutomatically).not.toHaveBeenCalled();
  });

  it("if the organizer wins the race, reports what is on record instead of claiming the tick", async () => {
    markArrivedAutomatically.mockResolvedValueOnce(null); // the SQL guard held
    selectParticipantForEventUser
      .mockResolvedValueOnce(participant())
      .mockResolvedValueOnce(
        participant({ attendanceStatus: "present", attendanceSource: "manual" }),
      );

    const result = await autoCheckIn(EVENT_ID, RIDER_ID, HERE);

    expect(result.outcome).toBe("already_recorded");
    expect(result.participant.attendanceSource).toBe("manual");
  });

  it("a private ride the caller cannot see stays a 404 from the event lookup", async () => {
    getEventForViewer.mockRejectedValue(new ApiError(404, "Event not found"));

    await expect(autoCheckIn(EVENT_ID, 999, HERE)).rejects.toMatchObject({ status: 404 });
    expect(selectParticipantForEventUser).not.toHaveBeenCalled();
  });
});
