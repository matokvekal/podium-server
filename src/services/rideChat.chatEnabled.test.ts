// Per-event "Enable Chat" (sql/056): the SERVER enforces it — direct API calls cannot read or send
// while it is off — and switching it off/on never touches the stored messages.
//
// canEvent (policy.ts) and the service run for real; only the database is stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, canEvent, type EventContext } from "../authz/policy.js";
import type { Event } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";

const selectRideChatMessages = vi.fn();
const insertRideChatMessage = vi.fn();
const getEventForViewer = vi.fn();

vi.mock("../queries/rideChat.queries.js", () => ({
  selectRideChatMessages: (...a: unknown[]) => selectRideChatMessages(...a),
  insertRideChatMessage: (...a: unknown[]) => insertRideChatMessage(...a),
  selectUnreadSummary: vi.fn(),
}));
vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
}));

const { listRideChat, sendRideChat } = await import("./rideChat.service.js");

const RIDE = "11111111-2222-3333-4444-555555555555";
const actor = {
  userId: 7,
  globalRole: "RIDER",
  entitlements: { features: new Set() },
} as unknown as Actor;

function viewOf(event: Partial<Event>, role: "owner" | null = "owner") {
  const full = {
    id: RIDE,
    ownerId: 7,
    visibility: "public",
    status: "published",
    ...event,
  } as Event;
  const context = { event: full, role, participation: role ? null : "approved" } as EventContext;
  return { event: full, actor, context, tier: "owner" };
}

async function failure(promise: Promise<unknown>) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return { status: (err as ApiError).status, message: (err as ApiError).message };
}

beforeEach(() => vi.clearAllMocks());

describe("chat OFF — the server refuses", () => {
  it("rejects a read (403 RIDE_CHAT_DISABLED) even for the owner, and reads no messages", async () => {
    getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: false }));
    const err = await failure(listRideChat(RIDE, 7, null));
    expect(err.status).toBe(403);
    expect(err.message).toContain("RIDE_CHAT_DISABLED");
    expect(selectRideChatMessages).not.toHaveBeenCalled();
  });

  it("rejects the polling read too (afterId)", async () => {
    getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: false }, null));
    expect((await failure(listRideChat(RIDE, 7, 42))).status).toBe(403);
    expect(selectRideChatMessages).not.toHaveBeenCalled();
  });

  it("rejects sending a message and stores nothing", async () => {
    getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: false }));
    expect((await failure(sendRideChat(RIDE, 7, "hello"))).status).toBe(403);
    expect(insertRideChatMessage).not.toHaveBeenCalled();
  });

  it("the policy itself grants no chat capability, whoever asks", () => {
    expect(canEvent(actor, "event:chat", viewOf({ chatEnabled: false }).context)).toBe(false);
    expect(canEvent(actor, "event:chat", viewOf({ chatEnabled: false }, null).context)).toBe(false);
  });
});

describe("chat ON — unchanged", () => {
  it.each([[true], [undefined]])(
    "chatEnabled=%s: existing events keep chat (owner reads and sends)",
    async (flag) => {
      getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: flag as boolean }));
      selectRideChatMessages.mockResolvedValue([]);
      insertRideChatMessage.mockResolvedValue({
        kind: "ok",
        row: {
          id: "1",
          user_id: "7",
          user_name: "N",
          message: "hi",
          created_at: new Date(),
          is_organizer: true,
        },
      });
      await expect(listRideChat(RIDE, 7, null)).resolves.toEqual([]);
      await expect(sendRideChat(RIDE, 7, "hi")).resolves.toMatchObject({ text: "hi" });
      expect(canEvent(actor, "event:chat", viewOf({ chatEnabled: flag as boolean }).context)).toBe(
        true,
      );
    },
  );
});

describe("history survives OFF -> ON", () => {
  it("the same stored messages are readable again once chat is switched back on", async () => {
    selectRideChatMessages.mockResolvedValue([
      {
        id: "1",
        user_id: "7",
        user_name: "N",
        message: "before",
        created_at: new Date(),
        is_organizer: false,
      },
    ]);

    getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: false }));
    await failure(listRideChat(RIDE, 7, null));
    expect(insertRideChatMessage).not.toHaveBeenCalled();

    getEventForViewer.mockResolvedValue(viewOf({ chatEnabled: true }));
    const messages = await listRideChat(RIDE, 7, null);
    expect(messages.map((m) => m.text)).toEqual(["before"]);
  });
});

describe("PROMOTE and Chat are independent", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, true],
    [false, false, false],
  ])("promoteOnly=%s chatEnabled=%s => chat capability %s", (promoteOnly, chatEnabled, expected) => {
    const { context } = viewOf({ promoteOnly, chatEnabled });
    expect(canEvent(actor, "event:chat", context)).toBe(expected);
  });
});
