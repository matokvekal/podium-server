// A start date in the past is refused, and a ride the auto-finish sweep closed without it ever
// starting stays editable by its organizer, while a ride that really started stays locked.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEvent = vi.fn();
const updateEventStatus = vi.fn();
const eventHasRecordedRiding = vi.fn();
const insertEvent = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
// A non-creator is checked against event_members for a manager role; here nobody is one.
vi.mock("../queries/eventManagers.queries.js", () => ({ selectEventMemberRole: async () => null }));
vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
    updateEventStatus: (...a: unknown[]) => updateEventStatus(...a),
    eventHasRecordedRiding: (...a: unknown[]) => eventHasRecordedRiding(...a),
    insertEvent: (...a: unknown[]) => insertEvent(...a),
  };
});

const { createEvent, isUnriddenAutoFinished, updateEventDetails } = await import(
  "./event.service.js"
);

const OWNER = 7;
const STRANGER = 99;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The 3 Kinneret rides: entered as 07/11/2026, stored as 11-Jul-2026, closed by the sweep. */
const SCHEDULED = new Date("2026-07-11T04:00:00.000Z");
function autoFinishedNeverStarted(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    ownerId: OWNER,
    status: "finished",
    visibility: "public",
    startsAt: SCHEDULED,
    endsAt: null,
    startedAt: null,
    // The sweep stamps the ride's own scheduled end, never the moment it ran.
    finishedAt: SCHEDULED,
    ...overrides,
  };
}

const future = () => new Date(Date.now() + 30 * DAY);

beforeEach(() => {
  for (const m of [
    selectEventById,
    updateEvent,
    updateEventStatus,
    eventHasRecordedRiding,
    insertEvent,
  ])
    m.mockReset();
  eventHasRecordedRiding.mockResolvedValue(false);
  updateEvent.mockImplementation(async (id: string) => ({ id }));
});

describe("createEvent — start date", () => {
  it("refuses a start date in the past and creates nothing", async () => {
    await expect(
      createEvent(OWNER, {
        name: "Sovev Kinneret",
        type: "RIDE",
        requiresBib: false,
        startsAt: SCHEDULED,
        displayMode: "standard",
        visibility: "public",
        requiresApproval: false,
        status: "published",
      } as Parameters<typeof createEvent>[1]),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already passed/) });
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("refuses a start more than 5 minutes ago (no hour of slack)", async () => {
    await expect(
      createEvent(OWNER, {
        name: "x",
        type: "RIDE",
        requiresBib: false,
        startsAt: new Date(Date.now() - 10 * 60 * 1000),
        displayMode: "standard",
        visibility: "public",
        requiresApproval: false,
        status: "published",
      } as Parameters<typeof createEvent>[1]),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateEventDetails — start date on an ordinary ride", () => {
  const published = {
    id: "e1",
    ownerId: OWNER,
    status: "published",
    startsAt: new Date(Date.now() + 3 * DAY),
    endsAt: null,
    startedAt: null,
    finishedAt: null,
  };

  it("refuses moving the start into the past and writes nothing", async () => {
    selectEventById.mockResolvedValue(published);
    await expect(
      updateEventDetails("e1", OWNER, { startsAt: new Date(Date.now() - 2 * DAY) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("still saves when the start is unchanged, even though it has already passed", async () => {
    const begunAnHourAgo = { ...published, startsAt: new Date(Date.now() - HOUR) };
    selectEventById.mockResolvedValue(begunAnHourAgo);
    await updateEventDetails("e1", OWNER, {
      startsAt: new Date(begunAnHourAgo.startsAt.getTime()),
      description: "bring water",
    });
    expect(updateEvent).toHaveBeenCalledTimes(1);
    expect(updateEventStatus).not.toHaveBeenCalled();
  });
});

describe("isUnriddenAutoFinished", () => {
  it("is true for an auto-finished ride nobody started or rode", async () => {
    expect(await isUnriddenAutoFinished(autoFinishedNeverStarted() as never)).toBe(true);
  });

  it("is false once the ride actually went live (started_at)", async () => {
    const started = autoFinishedNeverStarted({ startedAt: new Date(SCHEDULED.getTime() + 60_000) });
    expect(await isUnriddenAutoFinished(started as never)).toBe(false);
    expect(eventHasRecordedRiding).not.toHaveBeenCalled();
  });

  it("is false for a ride the organizer finished by hand (finished_at is the click, not the plan)", async () => {
    const manual = autoFinishedNeverStarted({
      finishedAt: new Date(SCHEDULED.getTime() + 3 * HOUR),
    });
    expect(await isUnriddenAutoFinished(manual as never)).toBe(false);
  });

  it("is false when any rider recorded GPS or a saved track", async () => {
    eventHasRecordedRiding.mockResolvedValue(true);
    expect(await isUnriddenAutoFinished(autoFinishedNeverStarted() as never)).toBe(false);
  });

  it("is false for anything not finished", async () => {
    const published = autoFinishedNeverStarted({ status: "published", finishedAt: null });
    expect(await isUnriddenAutoFinished(published as never)).toBe(false);
  });
});

describe("updateEventDetails — a never-started, auto-finished ride", () => {
  it("lets the creator set a future date, and reopens it as published", async () => {
    selectEventById.mockResolvedValue(autoFinishedNeverStarted());
    const newStart = future();
    await updateEventDetails("e1", OWNER, { startsAt: newStart, name: "Sovev Kinneret" });
    expect(updateEvent).toHaveBeenCalledWith("e1", expect.objectContaining({ startsAt: newStart }));
    expect(updateEventStatus).toHaveBeenCalledWith("e1", "published", true, null);
  });

  it("moves a stored end time with the start, so the sweep does not close it again", async () => {
    const endsAt = new Date(SCHEDULED.getTime() + 4 * HOUR);
    selectEventById.mockResolvedValue(autoFinishedNeverStarted({ endsAt, finishedAt: endsAt }));
    const newStart = future();
    await updateEventDetails("e1", OWNER, { startsAt: newStart });
    expect(updateEvent).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({ endsAt: new Date(newStart.getTime() + 4 * HOUR) }),
    );
  });

  it("refuses a past date, or no date, and leaves it finished", async () => {
    selectEventById.mockResolvedValue(autoFinishedNeverStarted());
    await expect(
      updateEventDetails("e1", OWNER, { startsAt: new Date(Date.now() - DAY) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(updateEventDetails("e1", OWNER, { name: "renamed" })).rejects.toMatchObject({
      status: 400,
    });
    expect(updateEvent).not.toHaveBeenCalled();
    expect(updateEventStatus).not.toHaveBeenCalled();
  });

  it("refuses anyone who does not organize the ride", async () => {
    selectEventById.mockResolvedValue(autoFinishedNeverStarted());
    await expect(updateEventDetails("e1", STRANGER, { startsAt: future() })).rejects.toMatchObject({
      status: 403,
    });
    expect(updateEvent).not.toHaveBeenCalled();
  });
});

describe("updateEventDetails — a ride that really started stays locked", () => {
  for (const [label, ride] of [
    ["went live", autoFinishedNeverStarted({ startedAt: new Date(SCHEDULED.getTime() + 60_000) })],
    [
      "finished by hand",
      autoFinishedNeverStarted({ finishedAt: new Date(SCHEDULED.getTime() + 3 * HOUR) }),
    ],
  ] as const) {
    it(`${label}: a date change is refused and the status never moves`, async () => {
      selectEventById.mockResolvedValue(ride);
      await expect(updateEventDetails("e1", OWNER, { startsAt: future() })).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/finished/),
      });
      expect(updateEvent).not.toHaveBeenCalled();
      expect(updateEventStatus).not.toHaveBeenCalled();
    });
  }

  it("riders recorded GPS: locked too", async () => {
    selectEventById.mockResolvedValue(autoFinishedNeverStarted());
    eventHasRecordedRiding.mockResolvedValue(true);
    await expect(updateEventDetails("e1", OWNER, { startsAt: future() })).rejects.toMatchObject({
      status: 400,
    });
    expect(updateEventStatus).not.toHaveBeenCalled();
  });

  it("its share switches can still be changed, as before", async () => {
    selectEventById.mockResolvedValue(
      autoFinishedNeverStarted({ startedAt: new Date(SCHEDULED.getTime() + 60_000) }),
    );
    await updateEventDetails("e1", OWNER, { showResults: true });
    expect(updateEvent).toHaveBeenCalledTimes(1);
    expect(updateEventStatus).not.toHaveBeenCalled();
  });
});
