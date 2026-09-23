// Ride chat (sql/047): authorization, validation, limits and the polling cursor.
//
// The queries and the event lookup are mocked; the AUTHORIZATION RULE is not — canEvent from
// policy.ts runs for real, so these tests fail if "event:chat" ever widens or narrows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, EventContext, EventRole, Participation } from "../authz/policy.js";
import type { Event } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";

const selectRideChatMessages = vi.fn();
const insertRideChatMessage = vi.fn();
const selectUnreadSummary = vi.fn();
const getEventForViewer = vi.fn();

vi.mock("../queries/rideChat.queries.js", () => ({
  selectRideChatMessages: (...a: unknown[]) => selectRideChatMessages(...a),
  insertRideChatMessage: (...a: unknown[]) => insertRideChatMessage(...a),
  selectUnreadSummary: (...a: unknown[]) => selectUnreadSummary(...a),
}));
vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
}));

const { listRideChat, sendRideChat, summarizeRideChats } = await import("./rideChat.service.js");
const { rideChatSendSchema, rideChatUnreadQuerySchema } = await import(
  "../schemas/rideChat.schemas.js"
);

const RIDE = "11111111-2222-3333-4444-555555555555";

function view(role: EventRole, participation: Participation, visibility = "public") {
  const event = { id: RIDE, ownerId: 1, visibility, status: "finished" } as unknown as Event;
  const actor = { userId: 7, globalRole: "RIDER", entitlements: { features: new Set() } };
  const context: EventContext = { event, role, participation };
  return { event, actor: actor as unknown as Actor, context, tier: "approved" };
}

function row(id: number, userId = 7) {
  return {
    id: String(id),
    user_id: String(userId),
    user_name: "Noa",
    message: `m${id}`,
    created_at: new Date("2026-09-23T06:42:00Z"),
    is_organizer: false,
  };
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reading", () => {
  it("an approved rider can read the chat — even on a finished ride (History)", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    selectRideChatMessages.mockResolvedValue([row(1), row(2)]);

    const messages = await listRideChat(RIDE, 7, null);

    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[0]).toMatchObject({ userId: 7, userName: "Noa", text: "m1" });
    expect(messages[0].createdAt).toBe("2026-09-23T06:42:00.000Z");
  });

  it("the organizer can read it", async () => {
    getEventForViewer.mockResolvedValue(view("owner", "none"));
    selectRideChatMessages.mockResolvedValue([]);
    await expect(listRideChat(RIDE, 1, null)).resolves.toEqual([]);
  });

  it("afterId is passed through so polling returns only newer messages", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    selectRideChatMessages.mockResolvedValue([row(43)]);

    const messages = await listRideChat(RIDE, 7, 42);

    expect(selectRideChatMessages).toHaveBeenCalledWith(RIDE, 42, expect.any(Number));
    expect(messages.map((m) => m.id)).toEqual([43]);
  });
});

describe("access", () => {
  it("a stranger on a public ride is refused (403) and nothing is read", async () => {
    getEventForViewer.mockResolvedValue(view(null, "none"));
    await expectStatus(listRideChat(RIDE, 9, null), 403);
    expect(selectRideChatMessages).not.toHaveBeenCalled();
  });

  it("a rider still waiting for approval is refused", async () => {
    getEventForViewer.mockResolvedValue(view(null, "pending"));
    await expectStatus(sendRideChat(RIDE, 9, "hi"), 403);
    expect(insertRideChatMessage).not.toHaveBeenCalled();
  });

  it("a ride that does not exist for the caller stays a 404", async () => {
    getEventForViewer.mockRejectedValue(new ApiError(404, "Event not found"));
    await expectStatus(listRideChat(RIDE, 9, null), 404);
  });
});

describe("sending", () => {
  it("an approved rider can send; the text is trimmed and identity comes from the caller", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    insertRideChatMessage.mockResolvedValue({ kind: "ok", row: row(5) });

    const message = await sendRideChat(RIDE, 7, "  I am at the parking lot  ");

    expect(insertRideChatMessage).toHaveBeenCalledWith(
      RIDE,
      7,
      "I am at the parking lot",
      expect.any(Number),
    );
    expect(message.id).toBe(5);
  });

  it("rejects an empty / whitespace-only message", async () => {
    await expectStatus(sendRideChat(RIDE, 7, "   \n "), 400);
    expect(insertRideChatMessage).not.toHaveBeenCalled();
  });

  it("rejects a message over 500 characters", async () => {
    await expectStatus(sendRideChat(RIDE, 7, "x".repeat(501)), 400);
    expect(insertRideChatMessage).not.toHaveBeenCalled();
  });

  it("accepts exactly 500 characters", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    insertRideChatMessage.mockResolvedValue({ kind: "ok", row: row(6) });
    await expect(sendRideChat(RIDE, 7, "x".repeat(500))).resolves.toMatchObject({ id: 6 });
  });

  it("enforces the per-ride message limit (409)", async () => {
    getEventForViewer.mockResolvedValue(view(null, "approved"));
    insertRideChatMessage.mockResolvedValue({ kind: "limit" });
    await expectStatus(sendRideChat(RIDE, 7, "one more"), 409);
    expect(insertRideChatMessage).toHaveBeenCalledWith(RIDE, 7, "one more", 500);
  });

  it("the send body carries only text — a client-supplied name, user or time is dropped", () => {
    const parsed = rideChatSendSchema.parse({
      text: "hi",
      userId: 1,
      userName: "Admin",
      createdAt: "2000-01-01",
      isOrganizer: true,
    });
    expect(parsed).toEqual({ text: "hi" });
  });
});

describe("unread summary", () => {
  it("parses rideId:lastReadId pairs and drops malformed ones", () => {
    const { rides } = rideChatUnreadQuerySchema.parse({
      rides: `${RIDE}:18442,not-a-uuid:3,${RIDE}:1,aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    });
    expect(rides).toEqual([
      { rideId: RIDE, lastReadId: 18442 },
      { rideId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", lastReadId: 0 },
    ]);
  });

  it("is one query for the whole list and maps ids to numbers", async () => {
    selectUnreadSummary.mockResolvedValue([{ ride_id: RIDE, latest_id: "44", unread: 3 }]);
    const result = await summarizeRideChats(7, [{ rideId: RIDE, lastReadId: 41 }]);
    expect(selectUnreadSummary).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ rideId: RIDE, latestId: 44, unread: 3 }]);
  });
});
