// Completion medal (sql/061) at the event boundary: config is the organizers' (owner or ride
// manager), ≤30 words, needs a dedication when on — and finishing a ride still succeeds when the
// medal award blows up.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventById = vi.fn();
const updateEvent = vi.fn();
const updateEventMedalConfig = vi.fn();
const updateEventStatus = vi.fn();
const selectEventMemberRole = vi.fn();
const awardMedalsForFinishedEvent = vi.fn();
const selectEventsForUser = vi.fn();
const selectMyMedalEventIds = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));
vi.mock("../queries/eventManagers.queries.js", () => ({
  selectEventMemberRole: (...a: unknown[]) => selectEventMemberRole(...a),
}));
vi.mock("./track-writer.js", () => ({ writeParticipantTracks: vi.fn() }));
vi.mock("../statistics/statistics.service.js", () => ({
  refreshStatsForFinishedEvent: vi.fn(),
}));
vi.mock("./eventMedals.service.js", () => ({
  awardMedalsForFinishedEvent: (...a: unknown[]) => awardMedalsForFinishedEvent(...a),
  selectMyMedalEventIds: (...a: unknown[]) => selectMyMedalEventIds(...a),
}));
vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
    updateEventMedalConfig: (...a: unknown[]) => updateEventMedalConfig(...a),
    updateEventStatus: (...a: unknown[]) => updateEventStatus(...a),
    markEventStarted: vi.fn(),
    selectEventsForUser: (...a: unknown[]) => selectEventsForUser(...a),
  };
});

const { updateEventDetails, changeEventStatus, listMyEvents } = await import("./event.service.js");
const { createEventSchema, updateEventSchema } = await import("../schemas/event.schemas.js");

const OWNER = 7;
const MANAGER = 8;
const RIDE = {
  id: "e1",
  ownerId: OWNER,
  status: "published",
  visibility: "public",
  medalEnabled: false,
  medalText: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectEventById.mockResolvedValue(RIDE);
  updateEvent.mockResolvedValue(RIDE);
  selectEventMemberRole.mockImplementation(async (_e: string, uid: number) =>
    uid === MANAGER ? "operator" : null,
  );
});

describe("edit: medal config", () => {
  it("owner and ride manager can switch it on with a dedication", async () => {
    await updateEventDetails("e1", OWNER, { medalEnabled: true, medalText: "Well done" });
    await updateEventDetails("e1", MANAGER, { medalEnabled: false });
    expect(updateEventMedalConfig.mock.calls).toEqual([
      ["e1", { medalEnabled: true, medalText: "Well done" }],
      ["e1", { medalEnabled: false, medalText: undefined }],
    ]);
  });

  it("anyone else gets a 403 and nothing is written", async () => {
    await expect(
      updateEventDetails("e1", 999, { medalEnabled: true, medalText: "Hi" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateEventMedalConfig).not.toHaveBeenCalled();
  });

  it("switching it on without any dedication is a 400", async () => {
    await expect(updateEventDetails("e1", OWNER, { medalEnabled: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(updateEventMedalConfig).not.toHaveBeenCalled();
  });

  it("switching it on reuses a dedication already stored", async () => {
    selectEventById.mockResolvedValue({ ...RIDE, medalText: "Kept from before" });
    await updateEventDetails("e1", OWNER, { medalEnabled: true });
    expect(updateEventMedalConfig).toHaveBeenCalledTimes(1);
  });

  it("an edit that does not mention the medal leaves it alone", async () => {
    await updateEventDetails("e1", OWNER, { name: "Renamed" });
    expect(updateEventMedalConfig).not.toHaveBeenCalled();
  });
});

describe("request schema: dedication ≤ 30 words", () => {
  const base = { name: "Ride", startsAt: "2030-10-01T04:00:00.000Z" };
  const words = (n: number) => Array.from({ length: n }, (_, i) => `מילה${i}`).join(" ");

  it("default: no medal fields at all", () => {
    const parsed = createEventSchema.parse(base);
    expect(parsed.medalEnabled).toBeUndefined();
    expect(parsed.medalText).toBeUndefined();
  });

  it("30 Hebrew words pass, 31 are refused (create and update)", () => {
    expect(createEventSchema.safeParse({ ...base, medalText: words(30) }).success).toBe(true);
    expect(createEventSchema.safeParse({ ...base, medalText: words(31) }).success).toBe(false);
    expect(updateEventSchema.safeParse({ medalText: words(31) }).success).toBe(false);
  });

  it("blank becomes null", () => {
    expect(updateEventSchema.parse({ medalText: "   " }).medalText).toBeNull();
  });
});

describe("finishing a ride", () => {
  it("runs the medal award, and still finishes when the award throws", async () => {
    const live = { ...RIDE, status: "live" };
    selectEventById.mockResolvedValue(live);
    updateEventStatus.mockResolvedValue({ ...live, status: "finished" });
    awardMedalsForFinishedEvent.mockRejectedValue(new Error("medals exploded"));
    // The service contract is "never throws"; even if it ever did, finishing must still succeed.
    await expect(changeEventStatus("e1", OWNER, "finished")).resolves.toMatchObject({
      status: "finished",
    });
    expect(updateEventStatus).toHaveBeenCalledWith("e1", "finished", false, expect.any(Date));
    expect(awardMedalsForFinishedEvent).toHaveBeenCalledWith("e1");
  });
});

describe("my rides: myMedal", () => {
  it("one batched lookup over the finished rides only", async () => {
    selectEventsForUser.mockResolvedValue([
      { id: "a", status: "finished", ownerId: 1 },
      { id: "b", status: "published", ownerId: 1 },
      { id: "c", status: "finished", ownerId: 1 },
    ]);
    selectMyMedalEventIds.mockResolvedValue(new Set(["c"]));
    const list = await listMyEvents(42, "joined");
    expect(selectMyMedalEventIds).toHaveBeenCalledTimes(1);
    expect(selectMyMedalEventIds).toHaveBeenCalledWith(42, ["a", "c"]);
    expect(list.map((e) => [e.id, e.myMedal ?? false])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
  });
});
