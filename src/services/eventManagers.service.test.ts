// Ride managers: who may appoint them, what an added email turns into, the sign-in claim, and
// the policy rules that make a manager (operator) run the ride like its creator.
//
// The queries and the event lookup are mocked; canEvent from policy.ts runs for real, so these
// tests fail if "event:manage_members" or the operator rules ever drift.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, EventContext, EventRole } from "../authz/policy.js";
import { canEvent } from "../authz/policy.js";
import type { Event } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";

const getEventForViewer = vi.fn();
const selectUserIdByEmail = vi.fn();
const insertEventManager = vi.fn();
const insertManagerInvite = vi.fn();
const deleteEventManager = vi.fn();
const deleteManagerInvite = vi.fn();
const selectEventManagers = vi.fn();
const selectManagerInvites = vi.fn();
const claimManagerInvitesForEmail = vi.fn();
const selectUserById = vi.fn();

vi.mock("./event.service.js", () => ({
  getEventForViewer: (...a: unknown[]) => getEventForViewer(...a),
}));
vi.mock("../queries/eventManagers.queries.js", () => ({
  selectUserIdByEmail: (...a: unknown[]) => selectUserIdByEmail(...a),
  insertEventManager: (...a: unknown[]) => insertEventManager(...a),
  insertManagerInvite: (...a: unknown[]) => insertManagerInvite(...a),
  deleteEventManager: (...a: unknown[]) => deleteEventManager(...a),
  deleteManagerInvite: (...a: unknown[]) => deleteManagerInvite(...a),
  selectEventManagers: (...a: unknown[]) => selectEventManagers(...a),
  selectManagerInvites: (...a: unknown[]) => selectManagerInvites(...a),
  claimManagerInvitesForEmail: (...a: unknown[]) => claimManagerInvitesForEmail(...a),
}));
vi.mock("../queries/user.queries.js", () => ({
  selectUserById: (...a: unknown[]) => selectUserById(...a),
}));

const { addEventManager, claimManagerInvites, listEventManagers, removeEventManager } =
  await import("./eventManagers.service.js");

const RIDE = "11111111-2222-3333-4444-555555555555";
const CREATOR = 1;

function view(role: EventRole, status = "published") {
  const event = { id: RIDE, ownerId: CREATOR, visibility: "public", status } as unknown as Event;
  // No plan features at all: appointing managers must not depend on the Club plan.
  const actor = { userId: 7, globalRole: "RIDER", entitlements: { features: new Set() } };
  const context: EventContext = { event, role, participation: "none" };
  return { event, actor: actor as unknown as Actor, context, tier: "public" };
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  await expect(promise).rejects.toMatchObject({ status });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectUserById.mockResolvedValue({ id: 2, firstName: "Dana", lastName: null, nickname: null });
  selectEventManagers.mockResolvedValue([]);
  selectManagerInvites.mockResolvedValue([]);
});

describe("policy: a manager runs the ride like its creator", () => {
  const can = (role: EventRole, capability: Parameters<typeof canEvent>[1]) => {
    const { actor, context } = view(role);
    return canEvent(actor, capability, context);
  };

  it("a manager may edit, change the route, run riders, manage stops and cancel", () => {
    for (const capability of [
      "event:edit",
      "event:manage_route",
      "event:manage_participants",
      "event:manage_stops",
      "event:change_status",
      "event:delete",
    ] as const) {
      expect(can("operator", capability), capability).toBe(true);
    }
  });

  it("only the creator appoints managers, on any plan", () => {
    expect(can("owner", "event:manage_members")).toBe(true);
    expect(can("operator", "event:manage_members")).toBe(false);
    expect(can(null, "event:manage_members")).toBe(false);
  });
});

describe("addEventManager", () => {
  it("an email with an account becomes a manager now", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    selectUserIdByEmail.mockResolvedValue(2);
    await expect(addEventManager(RIDE, CREATOR, "dana@gmail.com")).resolves.toEqual({
      status: "added",
      manager: { userId: 2, name: "Dana", email: "dana@gmail.com" },
    });
    expect(insertEventManager).toHaveBeenCalledWith(RIDE, 2);
    expect(insertManagerInvite).not.toHaveBeenCalled();
  });

  it("an unknown email waits for its first sign-in", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    selectUserIdByEmail.mockResolvedValue(null);
    await expect(addEventManager(RIDE, CREATOR, "new@gmail.com")).resolves.toEqual({
      status: "invited",
    });
    expect(insertManagerInvite).toHaveBeenCalledWith(RIDE, "new@gmail.com", CREATOR);
    expect(insertEventManager).not.toHaveBeenCalled();
  });

  it("the creator's own email is refused", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    selectUserIdByEmail.mockResolvedValue(CREATOR);
    await expectStatus(addEventManager(RIDE, CREATOR, "me@gmail.com"), 400);
    expect(insertEventManager).not.toHaveBeenCalled();
  });

  it("a manager cannot add more managers, and a stranger cannot either", async () => {
    for (const role of ["operator", null] as const) {
      getEventForViewer.mockResolvedValue(view(role));
      await expectStatus(addEventManager(RIDE, 7, "x@gmail.com"), 403);
    }
    expect(selectUserIdByEmail).not.toHaveBeenCalled();
  });
});

describe("removeEventManager", () => {
  it("the creator removes a manager", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    deleteEventManager.mockResolvedValue(true);
    await removeEventManager(RIDE, CREATOR, 2);
    expect(deleteEventManager).toHaveBeenCalledWith(RIDE, 2);
  });

  it("a manager cannot remove anyone (so never the creator)", async () => {
    getEventForViewer.mockResolvedValue(view("operator"));
    await expectStatus(removeEventManager(RIDE, 7, CREATOR), 403);
    expect(deleteEventManager).not.toHaveBeenCalled();
  });

  it("404 when that person is not a manager", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    deleteEventManager.mockResolvedValue(false);
    await expectStatus(removeEventManager(RIDE, CREATOR, 99), 404);
  });
});

describe("listEventManagers", () => {
  it("a manager sees the list but is not offered the controls", async () => {
    getEventForViewer.mockResolvedValue(view("operator"));
    const result = await listEventManagers(RIDE, 7);
    expect(result.canManage).toBe(false);
    expect(result.owner).toEqual({ userId: 2, name: "Dana" });
  });

  it("a rider or stranger is refused", async () => {
    getEventForViewer.mockResolvedValue(view(null));
    await expectStatus(listEventManagers(RIDE, 7), 403);
  });

  it("a database without sql/059 shows no pending invites instead of failing", async () => {
    getEventForViewer.mockResolvedValue(view("owner"));
    selectManagerInvites.mockRejectedValue(Object.assign(new Error("nope"), { code: "42P01" }));
    await expect(listEventManagers(RIDE, CREATOR)).resolves.toMatchObject({ pending: [] });
  });
});

describe("claimManagerInvites (sign-in)", () => {
  it("claims with the normalised email", async () => {
    claimManagerInvitesForEmail.mockResolvedValue([RIDE]);
    await claimManagerInvites(5, "  Dana@Gmail.com ");
    expect(claimManagerInvitesForEmail).toHaveBeenCalledWith(5, "dana@gmail.com");
  });

  it("never throws, so a sign-in cannot fail because of it", async () => {
    claimManagerInvitesForEmail.mockRejectedValue(new Error("db down"));
    await expect(claimManagerInvites(5, "dana@gmail.com")).resolves.toBeUndefined();
  });

  it("does nothing without an email", async () => {
    await claimManagerInvites(5, null);
    expect(claimManagerInvitesForEmail).not.toHaveBeenCalled();
  });
});
