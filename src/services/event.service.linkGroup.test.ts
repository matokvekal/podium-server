// One /share link over 2-3 rides on the same day (sql/037) — the service rules.
//
// Properties worth protecting, each of which has a plausible wrong implementation:
//
//   1. EVERY REFUSAL IS 400, NEVER 409. The client's apiMutate() reads any 409 as "already
//      applied, treat as success", so a 409 here would tell an organizer their rides were
//      connected at the exact moment the server refused. Nothing calls apiMutate yet, which is
//      why this is pinned now rather than discovered later.
//   2. THE SPAN IS COMPUTED OVER THE WHOLE SET, NOT PAIRWISE. Pairwise is not transitive:
//      08:00, +20h and +40h each sit within a day of a neighbour while the group spans two.
//   3. A GROUP OF ONE IS NOT A GROUP. Dropping to a single member clears that member too,
//      or its link would open a chooser with exactly one card on it.
//   4. IT IS A FULL REPLACE. Rides dropped from the submitted membership go back to sharing on
//      their own instead of being left pointing at a group they are no longer in.
//   5. THE SHARE READ ANSWERS WITH THE GROUP'S CURRENT MEMBERS, not the codes in the URL — that
//      is what lets a link already sitting in a group chat survive the organizer's edits.
//
// No test database: the query layer is stubbed and the assertions are on what the service asks
// it to do — the same harness event.service.test.ts uses.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-error.js";

const selectEventById = vi.fn();
const selectEventsByLinkGroup = vi.fn();
const selectEventsByCodes = vi.fn();
const applyEventLinkGroup = vi.fn();
const selectParticipantByEventAndUser = vi.fn();
const markParticipantLeft = vi.fn();

vi.mock("../db/audit/audit.service.js", () => ({ trackAuditEvent: vi.fn() }));

vi.mock("../queries/event.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/event.queries.js")>(
    "../queries/event.queries.js",
  );
  return {
    ...actual,
    selectEventById: (...a: unknown[]) => selectEventById(...a),
    selectEventsByLinkGroup: (...a: unknown[]) => selectEventsByLinkGroup(...a),
    selectEventsByCodes: (...a: unknown[]) => selectEventsByCodes(...a),
    applyEventLinkGroup: (...a: unknown[]) => applyEventLinkGroup(...a),
    selectParticipantByEventAndUser: (...a: unknown[]) => selectParticipantByEventAndUser(...a),
    markParticipantLeft: (...a: unknown[]) => markParticipantLeft(...a),
  };
});

// buildActor / buildEventContext are the only DB touch left in getEventForViewer. The real
// policy is kept — the point is to exercise the actual capability rules, not a stub of them.
vi.mock("../authz/actor.js", async () => {
  const actual = await vi.importActual<typeof import("../authz/actor.js")>("../authz/actor.js");
  return {
    ...actual,
    buildActor: async (userId: number | null) => ({
      userId,
      globalRole: userId === null ? "guest" : "RIDER",
      entitlements: { features: new Set(), limits: {} },
    }),
    buildEventContext: async (event: { ownerId: number | null }, userId: number | null) => ({
      event,
      role: userId !== null && event.ownerId === userId ? "owner" : null,
      participation: "none",
    }),
  };
});

const {
  setEventLinkGroup,
  clearEventLinkGroup,
  getSharedRideGroup,
  getLinkedRidesForViewer,
  getEventForViewer,
  leaveEvent,
} = await import("./event.service.js");

const OWNER = 7;
const STRANGER = 99;

const SATURDAY = "2026-09-19T04:00:00.000Z";

function ride(overrides: Record<string, unknown> = {}) {
  return {
    id: "long",
    code: "19092026A",
    name: "Long loop",
    ownerId: OWNER,
    status: "published",
    visibility: "public",
    showEventInfo: true,
    showRoute: true,
    startsAt: new Date(SATURDAY),
    linkGroupId: null,
    ...overrides,
  };
}

const LONG = ride();
const SHORT = ride({
  id: "short",
  code: "19092026B",
  name: "Short loop",
  startsAt: new Date("2026-09-19T04:30:00.000Z"),
});

/** getEventForViewer reads through selectEventById, so the rides under test live in one map. */
function serveRides(rides: Record<string, unknown>[]) {
  const byId = new Map(rides.map((r) => [r.id as string, r]));
  selectEventById.mockImplementation(async (id: string) => byId.get(id) ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  applyEventLinkGroup.mockResolvedValue(true);
  selectEventsByLinkGroup.mockResolvedValue([]);
});

describe("setEventLinkGroup — who may", () => {
  it("refuses to pull in someone else's PUBLIC ride — 403, because that ride is not a secret", async () => {
    serveRides([LONG, ride({ id: "theirs", ownerId: STRANGER })]);
    await expect(setEventLinkGroup("long", OWNER, ["theirs"])).rejects.toMatchObject({
      status: 403,
    });
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });

  it("answers 404 for someone else's PRIVATE ride — a guessed id must learn nothing", async () => {
    serveRides([
      LONG,
      ride({ id: "theirs", ownerId: STRANGER, visibility: "private", code: "19092026Z" }),
    ]);
    await expect(setEventLinkGroup("long", OWNER, ["theirs"])).rejects.toMatchObject({
      status: 404,
    });
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });

  it("refuses when the caller owns neither ride", async () => {
    serveRides([LONG, SHORT]);
    await expect(setEventLinkGroup("long", STRANGER, ["short"])).rejects.toMatchObject({
      status: 403,
    });
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });
});

describe("setEventLinkGroup — the rules, all 400", () => {
  it("refuses more than three rides", async () => {
    const third = ride({ id: "gravel", code: "19092026C" });
    const fourth = ride({ id: "night", code: "19092026D" });
    serveRides([LONG, SHORT, third, fourth]);
    const err = await setEventLinkGroup("long", OWNER, ["short", "gravel", "night"]).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });

  it("refuses a ride with no start time — it cannot be 'on the same day' as anything", async () => {
    serveRides([LONG, ride({ id: "someday", startsAt: null, name: "Someday" })]);
    const err = await setEventLinkGroup("long", OWNER, ["someday"]).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain("Someday");
  });

  it("⚠ computes the span over the WHOLE set, not pairwise: 08:00 / +20h / +40h is refused", async () => {
    const plus20 = ride({
      id: "plus20",
      code: "19092026B",
      startsAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    const plus40 = ride({
      id: "plus40",
      code: "19092026C",
      startsAt: new Date("2026-09-20T20:00:00.000Z"),
    });
    serveRides([LONG, plus20, plus40]);
    const err = await setEventLinkGroup("long", OWNER, ["plus20", "plus40"]).catch((e) => e);
    expect(err.status).toBe(400);
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });

  it("accepts a pair that straddles midnight but is within the day-long span", async () => {
    const lateNight = ride({
      id: "night",
      code: "19092026B",
      startsAt: new Date("2026-09-19T20:00:00.000Z"),
    });
    serveRides([LONG, lateNight]);
    selectEventsByLinkGroup.mockResolvedValue([LONG, lateNight]);
    await expect(setEventLinkGroup("long", OWNER, ["night"])).resolves.toHaveLength(2);
  });

  it("never answers 409 for any refusal — apiMutate would read that as success", async () => {
    serveRides([LONG, ride({ id: "someday", startsAt: null })]);
    const cases = [
      setEventLinkGroup("long", OWNER, ["someday"]),
      setEventLinkGroup("long", OWNER, ["nope"]),
    ];
    for (const attempt of cases) {
      const err = await attempt.catch((e) => e);
      expect(err.status).not.toBe(409);
    }
  });
});

describe("setEventLinkGroup — the write", () => {
  it("stamps one id on every member and releases nothing on a first save", async () => {
    serveRides([LONG, SHORT]);
    selectEventsByLinkGroup.mockResolvedValue([LONG, SHORT]);
    await setEventLinkGroup("long", OWNER, ["short"]);

    expect(applyEventLinkGroup).toHaveBeenCalledTimes(1);
    const call = applyEventLinkGroup.mock.calls[0][0];
    expect(call.assignIds.sort()).toEqual(["long", "short"]);
    expect(call.clearIds).toEqual([]);
    expect(call.linkGroupId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts the anchor's own id in the body without making it a fourth ride", async () => {
    serveRides([LONG, SHORT]);
    selectEventsByLinkGroup.mockResolvedValue([LONG, SHORT]);
    await setEventLinkGroup("long", OWNER, ["long", "short"]);
    expect(applyEventLinkGroup.mock.calls[0][0].assignIds.sort()).toEqual(["long", "short"]);
  });

  it("is a REPLACE: a ride dropped from the membership is released back to sharing alone", async () => {
    const grouped = { ...LONG, linkGroupId: "old-group" };
    const droppedRide = ride({ id: "gravel", code: "19092026C", linkGroupId: "old-group" });
    serveRides([grouped, SHORT, droppedRide]);
    // The old group held long + gravel; the new membership is long + short.
    selectEventsByLinkGroup.mockImplementation(async (id: string) =>
      id === "old-group" ? [grouped, droppedRide] : [grouped, SHORT],
    );

    await setEventLinkGroup("long", OWNER, ["short"]);

    const call = applyEventLinkGroup.mock.calls[0][0];
    expect(call.clearIds).toEqual(["gravel"]);
    expect(call.assignIds.sort()).toEqual(["long", "short"]);
  });

  it("dissolves the group when the submitted membership is just this ride", async () => {
    const grouped = { ...LONG, linkGroupId: "old-group" };
    serveRides([grouped]);
    selectEventsByLinkGroup.mockResolvedValue([grouped]);
    await setEventLinkGroup("long", OWNER, []);
    expect(applyEventLinkGroup.mock.calls[0][0].assignIds).toEqual([]);
    expect(applyEventLinkGroup.mock.calls[0][0].clearIds).toContain("long");
  });

  it("answers 503 rather than a false success when sql/037 has not been applied", async () => {
    serveRides([LONG, SHORT]);
    applyEventLinkGroup.mockResolvedValue(false);
    await expect(setEventLinkGroup("long", OWNER, ["short"])).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("clearEventLinkGroup — a group of one is not a group", () => {
  it("clears the last remaining sibling too", async () => {
    const grouped = { ...LONG, linkGroupId: "g1" };
    const sibling = ride({ id: "short", code: "19092026B", linkGroupId: "g1" });
    serveRides([grouped, sibling]);
    selectEventsByLinkGroup.mockResolvedValue([grouped, sibling]);

    await clearEventLinkGroup("long", OWNER);

    expect(applyEventLinkGroup.mock.calls[0][0].clearIds.sort()).toEqual(["long", "short"]);
  });

  it("clears only this ride when two others remain grouped", async () => {
    const grouped = { ...LONG, linkGroupId: "g1" };
    const b = ride({ id: "short", code: "19092026B", linkGroupId: "g1" });
    const c = ride({ id: "gravel", code: "19092026C", linkGroupId: "g1" });
    serveRides([grouped, b, c]);
    selectEventsByLinkGroup.mockResolvedValue([grouped, b, c]);

    await clearEventLinkGroup("long", OWNER);

    expect(applyEventLinkGroup.mock.calls[0][0].clearIds).toEqual(["long"]);
  });

  it("is a no-op for a ride that was never in a group", async () => {
    serveRides([LONG]);
    await expect(clearEventLinkGroup("long", OWNER)).resolves.toEqual([LONG]);
    expect(applyEventLinkGroup).not.toHaveBeenCalled();
  });
});

describe("getSharedRideGroup — resolving a /share link", () => {
  it("answers with the group's CURRENT members, including one added after the link was sent", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    const b = { ...SHORT, linkGroupId: "g1" };
    const addedLater = ride({ id: "gravel", code: "19092026C", linkGroupId: "g1" });
    serveRides([a, b, addedLater]);
    selectEventsByCodes.mockResolvedValue([a, b]);
    selectEventsByLinkGroup.mockResolvedValue([a, b, addedLater]);

    const group = await getSharedRideGroup(["19092026A", "19092026B"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["long", "short", "gravel"]);
  });

  it("ignores a code that is no longer in the group instead of failing the whole link", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    const removed = ride({ id: "gravel", code: "19092026C", linkGroupId: null });
    serveRides([a, removed]);
    selectEventsByCodes.mockResolvedValue([a, removed]);
    selectEventsByLinkGroup.mockResolvedValue([a]);

    const group = await getSharedRideGroup(["19092026A", "19092026C"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["long"]);
  });

  it("drops cancelled and finished members — a chooser never offers a ride nobody can join", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    const done = ride({ id: "short", code: "19092026B", linkGroupId: "g1", status: "finished" });
    const off = ride({ id: "gravel", code: "19092026C", linkGroupId: "g1", status: "cancelled" });
    serveRides([a, done, off]);
    selectEventsByCodes.mockResolvedValue([a]);
    selectEventsByLinkGroup.mockResolvedValue([a, done, off]);

    const group = await getSharedRideGroup(["19092026A"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["long"]);
  });

  it("⚠ LISTS a private member to a stranger — the link is the key, exactly like a ride code", async () => {
    // This is the bug the feature shipped with. Rides are private BY DEFAULT, and every
    // private member used to be dropped: an organizer who connected their two ordinary rides
    // and sent the link got "No rides found for that link" for everyone but themselves.
    const a = { ...LONG, linkGroupId: "g1", visibility: "private" as const };
    const b = ride({
      id: "short",
      code: "19092026B",
      linkGroupId: "g1",
      visibility: "private",
    });
    serveRides([a, b]);
    selectEventsByCodes.mockResolvedValue([a]);
    selectEventsByLinkGroup.mockResolvedValue([a, b]);

    const group = await getSharedRideGroup(["19092026A"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["long", "short"]);
    // Connecting them into one link IS the organizer publishing them together, so the cards
    // are filled in rather than being two bare names nobody could choose between.
    expect(group.members.every((m) => m.canSeeInfo)).toBe(true);
  });

  it("does not fill in a private ride reached by a link whose group is gone", async () => {
    // No group left: nothing was published together any more, so the ordinary rule applies
    // and the card is redacted by the controller. The ride is still listed — its code is in
    // the URL, which is the same key /join/<code> has always accepted.
    const alone = ride({ id: "short", code: "19092026B", linkGroupId: null, visibility: "private" });
    serveRides([alone]);
    selectEventsByCodes.mockResolvedValue([alone]);

    const group = await getSharedRideGroup(["19092026B"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["short"]);
    expect(group.members[0].canSeeInfo).toBe(false);
  });

  it("fills in a member whose BROWSING info is off — a link is an invitation, not browsing", async () => {
    // show_event_info closes a ride to people scrolling Find Rides. It is not an answer to
    // "someone I sent this link to opened it": the organizer connected this ride into that
    // link and handed the link out, which is the more specific act of the two. The chooser
    // cannot ask "which one are you riding?" over cards with no time on them.
    const a = { ...LONG, linkGroupId: "g1", showEventInfo: false };
    serveRides([a]);
    selectEventsByCodes.mockResolvedValue([a]);
    selectEventsByLinkGroup.mockResolvedValue([a]);

    const group = await getSharedRideGroup(["19092026A"], STRANGER);

    expect(group.members).toHaveLength(1);
    expect(group.members[0].canSeeInfo).toBe(true);
  });

  it("still refuses the ROUTE of a private member — the card is not the map", async () => {
    // What the link opens up is the chooser's card. The geometry stays behind the ride's own
    // rule, which the chooser fetches per card through GET /events/:id/route.
    const a = { ...LONG, linkGroupId: "g1", visibility: "private" as const };
    serveRides([a]);

    const view = await getEventForViewer("long", STRANGER).catch((err: unknown) => err);

    expect(view).toBeInstanceOf(ApiError);
    expect((view as ApiError).status).toBe(404);
  });

  it("and marks canSeeInfo true for an ordinary public member", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    serveRides([a]);
    selectEventsByCodes.mockResolvedValue([a]);
    selectEventsByLinkGroup.mockResolvedValue([a]);

    const group = await getSharedRideGroup(["19092026A"], null);

    expect(group.members[0].canSeeInfo).toBe(true);
  });

  it("falls back to the codes when none of them is in a group any more", async () => {
    serveRides([LONG]);
    selectEventsByCodes.mockResolvedValue([LONG]);

    const group = await getSharedRideGroup(["19092026A"], null);

    expect(group.linkGroupId).toBeNull();
    expect(group.members.map((m) => m.event.id)).toEqual(["long"]);
    expect(selectEventsByLinkGroup).not.toHaveBeenCalled();
  });

  it("404s when no code resolves", async () => {
    selectEventsByCodes.mockResolvedValue([]);
    await expect(getSharedRideGroup(["NOPE"], null)).rejects.toMatchObject({ status: 404 });
  });
});

describe("getLinkedRidesForViewer — the switch-ride chip", () => {
  it("returns nothing for an ungrouped ride, without querying", async () => {
    await expect(getLinkedRidesForViewer(LONG as never, OWNER)).resolves.toEqual([]);
    expect(selectEventsByLinkGroup).not.toHaveBeenCalled();
  });

  it("excludes the ride itself and any cancelled sibling", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    const b = ride({ id: "short", code: "19092026B", linkGroupId: "g1" });
    const off = ride({ id: "gravel", code: "19092026C", linkGroupId: "g1", status: "cancelled" });
    selectEventsByLinkGroup.mockResolvedValue([a, b, off]);

    const linked = await getLinkedRidesForViewer(a as never, OWNER);

    expect(linked.map((r) => r.id)).toEqual(["short"]);
  });

  it("⚠ leaves out a FINISHED sibling, so the chip counts what the chooser will offer", async () => {
    const a = { ...LONG, linkGroupId: "g1" };
    const over = ride({ id: "short", code: "19092026B", linkGroupId: "g1", status: "finished" });
    selectEventsByLinkGroup.mockResolvedValue([a, over]);

    await expect(getLinkedRidesForViewer(a as never, OWNER)).resolves.toEqual([]);
  });

  it("⚠ KEEPS a private sibling, so the chip counts what the chooser will offer", async () => {
    // The counterpart of the chooser's own rule. Hiding it here told a rider on this ride
    // that it was the only one that day, while the link they arrived through offers both.
    const a = { ...LONG, linkGroupId: "g1" };
    const quiet = ride({
      id: "secret",
      code: "19092026B",
      linkGroupId: "g1",
      visibility: "private",
    });
    selectEventsByLinkGroup.mockResolvedValue([a, quiet]);

    const linked = await getLinkedRidesForViewer(a as never, null);

    expect(linked.map((r) => r.id)).toEqual(["secret"]);
  });
});

describe("leaveEvent — the endpoint the client had been calling against nothing", () => {
  it("stamps left_at on the caller's own row", async () => {
    serveRides([LONG]);
    selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: null });
    await leaveEvent("long", 5);
    expect(markParticipantLeft).toHaveBeenCalledWith(42, 5);
  });

  it("is idempotent: leaving a ride you already left writes nothing and does not throw", async () => {
    serveRides([LONG]);
    selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: new Date() });
    await expect(leaveEvent("long", 5)).resolves.toBeUndefined();
    expect(markParticipantLeft).not.toHaveBeenCalled();
  });

  it("is a no-op for someone who was never on the list", async () => {
    serveRides([LONG]);
    selectParticipantByEventAndUser.mockResolvedValue(null);
    await expect(leaveEvent("long", 5)).resolves.toBeUndefined();
    expect(markParticipantLeft).not.toHaveBeenCalled();
  });

  it("404s for a ride that does not exist", async () => {
    serveRides([]);
    await expect(leaveEvent("gone", 5)).rejects.toMatchObject({ status: 404 });
  });
});

describe("⚠ a finished ride is closed — switching off it is blocked", () => {
  it("refuses to leave a finished ride with 400, and writes nothing", async () => {
    serveRides([ride({ status: "finished" })]);
    selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: null });

    await expect(leaveEvent("long", 5)).rejects.toMatchObject({ status: 400 });
    expect(markParticipantLeft).not.toHaveBeenCalled();
  });

  it("also refuses a ride whose END TIME has passed, even with status still 'live'", async () => {
    // computeEffectiveStatus is what the rest of the app shows; gating on the raw column would
    // leave a ride that visibly ended yesterday still leavable.
    serveRides([
      ride({
        status: "live",
        endsAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    ]);
    selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: null });

    await expect(leaveEvent("long", 5)).rejects.toMatchObject({ status: 400 });
    expect(markParticipantLeft).not.toHaveBeenCalled();
  });

  it("⚠ but a LIVE ride is still leavable — swapping groups mid-ride is normal", async () => {
    serveRides([ride({ status: "live" })]);
    selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: null });

    await leaveEvent("long", 5);

    expect(markParticipantLeft).toHaveBeenCalledWith(42, 5);
  });

  it("and so is a ride that has not started yet", async () => {
    for (const status of ["published", "registration_open", "ready"] as const) {
      vi.clearAllMocks();
      serveRides([ride({ status })]);
      selectParticipantByEventAndUser.mockResolvedValue({ id: 42, leftAt: null });

      await leaveEvent("long", 5);

      expect(markParticipantLeft, status).toHaveBeenCalledWith(42, 5);
    }
  });

  it("never offers a finished ride as a switch TARGET either", async () => {
    // The other direction of the same rule, enforced in getSharedRideGroup.
    const live = { ...LONG, linkGroupId: "g1" };
    const over = ride({ id: "short", code: "19092026B", linkGroupId: "g1", status: "finished" });
    serveRides([live, over]);
    selectEventsByCodes.mockResolvedValue([live]);
    selectEventsByLinkGroup.mockResolvedValue([live, over]);

    const group = await getSharedRideGroup(["19092026A"], null);

    expect(group.members.map((m) => m.event.id)).toEqual(["long"]);
  });
});
