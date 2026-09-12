// Cover for THE CONCURRENT-LIVE-EVENTS BUG (sql/033's header has the full story): changeEventStatus
// used to refuse a SECOND live event outright (selectLiveEventForOwner, "does any live event
// exist"), so MAX_CONCURRENT_LIVE_EVENTS_FREE / an organizer's raised user_limits row never had
// any effect. It now compares a real count against the owner's actual maxConcurrentLiveEvents.
//
// No test database, so the queries and actor layers are stubbed and the assertions are on what
// changeEventStatus does with them — same harness as event.service.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../authz/policy.js";

const selectEventById = vi.fn();
const countLiveEventsForOwner = vi.fn();
const updateEventStatus = vi.fn();
const buildActor = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));

vi.mock("../authz/actor.js", async () => {
  const actual = await vi.importActual<typeof import("../authz/actor.js")>("../authz/actor.js");
  return { ...actual, buildActor: (...a: unknown[]) => buildActor(...a) };
});

vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    countLiveEventsForOwner: (...a: unknown[]) => countLiveEventsForOwner(...a),
    updateEventStatus: (...a: unknown[]) => updateEventStatus(...a),
  };
});

const { changeEventStatus } = await import("./event.service.js");

const OWNER = 7;
const RIDE = { id: "e1", ownerId: OWNER, status: "published", finishedAt: null };

function actorWithLimit(maxConcurrentLiveEvents: number): Actor {
  return {
    userId: OWNER,
    globalRole: "RIDER",
    entitlements: { limits: { maxConcurrentLiveEvents } },
  } as unknown as Actor;
}

beforeEach(() => {
  selectEventById.mockReset().mockResolvedValue({ ...RIDE });
  updateEventStatus.mockReset().mockImplementation(async (id: string, status: string) => ({
    ...RIDE,
    id,
    status,
  }));
  buildActor.mockReset().mockResolvedValue(actorWithLimit(1));
  countLiveEventsForOwner.mockReset().mockResolvedValue(0);
});

describe("changeEventStatus -> live", () => {
  it("goes live when the owner has no other live event, at the default limit of 1", async () => {
    countLiveEventsForOwner.mockResolvedValue(0);

    const result = await changeEventStatus("e1", OWNER, "live");

    expect(result.status).toBe("live");
    expect(countLiveEventsForOwner).toHaveBeenCalledWith(OWNER, "e1");
  });

  it("refuses a 2nd live event at the default limit of 1 — the bug this closes", async () => {
    countLiveEventsForOwner.mockResolvedValue(1);

    await expect(changeEventStatus("e1", OWNER, "live")).rejects.toMatchObject({ status: 409 });
    expect(updateEventStatus).not.toHaveBeenCalled();
  });

  it("admits a real 2nd concurrent live event once the owner's limit is raised", async () => {
    buildActor.mockResolvedValue(actorWithLimit(2));
    countLiveEventsForOwner.mockResolvedValue(1);

    const result = await changeEventStatus("e1", OWNER, "live");

    expect(result.status).toBe("live");
  });

  it("counts the owner's OTHER events, excluding the one being moved to live itself", async () => {
    await changeEventStatus("e1", OWNER, "live");

    // Re-publishing the very event being transitioned must never count against its own limit.
    expect(countLiveEventsForOwner).toHaveBeenCalledWith(OWNER, "e1");
  });
});
