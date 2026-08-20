// Waves 5 and 6: ride groups, teams, following an organizer, and the free-plan limits.
//
// All three features had fully built client screens backed by nothing but localStorage — a
// member added on the organizer's phone existed on no other device. The plan limits existed
// only as a constant in a browser, which is to say not at all.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/lib/google-auth.js", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  InvalidGoogleTokenError: class InvalidGoogleTokenError extends Error {},
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

const { createApp } = await import("../src/app.js");
const { FREE_PLAN } = await import("../src/authz/plans.js");

type App = ReturnType<typeof createApp>;

async function signIn(app: App, subject: string, firstName = "Test", lastName = "Rider") {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    firstName,
    lastName,
    displayName: null,
    picture: null,
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return { token: res.body.accessToken as string, userId: res.body.user.id as number };
}

async function createEvent(app: App, token: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/v1/events")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Saturday Ride", visibility: "public", ...body });
  return res.body.data;
}

async function publish(app: App, token: string, eventId: string) {
  await request(app)
    .patch(`/api/v1/events/${eventId}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "published" });
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("ride groups", () => {
  async function eventWithRiders(app: App, count = 3) {
    const { token } = await signIn(app, "groups-owner");
    const event = await createEvent(app, token);
    const imported = await request(app)
      .post(`/api/v1/events/${event.id}/participants/import`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        participants: Array.from({ length: count }, (_, i) => ({ name: `Rider ${i + 1}` })),
      });
    return {
      token,
      eventId: event.id as string,
      riderIds: imported.body.data.map((r: { id: number }) => r.id) as number[],
    };
  }

  it("creates a group with its own start time and track", async () => {
    const app = createApp();
    const { token, eventId } = await eventWithRiders(app);

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Elite", startsAt: "2026-09-01T04:00:00.000Z" });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Elite");
    expect(res.body.data.startsAt).toBe("2026-09-01T04:00:00.000Z");
    expect(res.body.data.routeId).toBeNull();
  });

  it("clears a start time back to 'rides with the event'", async () => {
    const app = createApp();
    const { token, eventId } = await eventWithRiders(app);
    const created = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Masters", startsAt: "2026-09-01T04:00:00.000Z" });

    // An explicit null is an instruction, not an omission.
    const cleared = await request(app)
      .patch(`/api/v1/events/${eventId}/groups/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ startsAt: null });
    expect(cleared.body.data.startsAt).toBeNull();
  });

  it("assigns riders in bulk, and moves them out again", async () => {
    const app = createApp();
    const { token, eventId, riderIds } = await eventWithRiders(app);
    const group = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beginners" });

    const assigned = await request(app)
      .post(`/api/v1/events/${eventId}/groups/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ participantIds: riderIds, groupId: group.body.data.id });
    expect(assigned.body.data.assigned).toBe(3);

    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.every((r: { groupId: number }) => r.groupId === group.body.data.id)).toBe(
      true,
    );

    // null takes them out of every group without removing them from the ride.
    await request(app)
      .post(`/api/v1/events/${eventId}/groups/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ participantIds: riderIds, groupId: null });
    const after = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.data.every((r: { groupId: null }) => r.groupId === null)).toBe(true);
    expect(after.body.data).toHaveLength(3);
  });

  it("refuses the whole assignment if any rider is not in this event", async () => {
    const app = createApp();
    const { token, eventId, riderIds } = await eventWithRiders(app);
    const group = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beginners" });

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/groups/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ participantIds: [...riderIds, 999999], groupId: group.body.data.id });
    expect(res.status).toBe(400);

    // Nothing applied — a partly-applied assignment leaves the organizer's screen lying.
    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.every((r: { groupId: null }) => r.groupId === null)).toBe(true);
  });

  it("keeps the riders when a group is deleted", async () => {
    const app = createApp();
    const { token, eventId, riderIds } = await eventWithRiders(app);
    const group = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Temporary" });
    await request(app)
      .post(`/api/v1/events/${eventId}/groups/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ participantIds: riderIds, groupId: group.body.data.id });

    await request(app)
      .delete(`/api/v1/events/${eventId}/groups/${group.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);

    // Tidying up groups must never drop anyone from the start list.
    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.every((r: { groupId: null }) => r.groupId === null)).toBe(true);
  });

  it("403s a non-owner creating a group", async () => {
    const app = createApp();
    const { eventId } = await eventWithRiders(app);
    const { token: otherToken } = await signIn(app, "groups-other");

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/groups`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Mine now" });
    expect(res.status).toBe(403);
  });
});

describe("teams", () => {
  it("creates a team and lists it for its owner", async () => {
    const app = createApp();
    const { token } = await signIn(app, "team-owner");

    const created = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Galilee Cycling Club" });
    expect(created.status).toBe(201);

    const list = await request(app).get("/api/v1/teams").set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe("Galilee Cycling Club");
  });

  it("adds members in bulk, pre-approved", async () => {
    const app = createApp();
    const { token } = await signIn(app, "team-owner-2");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Club" });

    const res = await request(app)
      .post(`/api/v1/teams/${team.body.data.id}/members`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        members: [
          { name: "Ada Lovelace", phone: "+972500000001" },
          { name: "Bea Smith", email: "bea@example.com" },
        ],
      });

    expect(res.status).toBe(201);
    // An organizer adding you IS the approval.
    expect(res.body.data.every((m: { status: string }) => m.status === "approved")).toBe(true);
  });

  it("puts a rider who asks to join into waiting_approval, and lets the owner approve", async () => {
    const app = createApp();
    const { token: ownerToken } = await signIn(app, "team-owner-3");
    const { token: riderToken, userId } = await signIn(app, "team-joiner", "Ada", "Lovelace");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Club" });
    const teamId = team.body.data.id;

    const joined = await request(app)
      .post(`/api/v1/teams/${teamId}/join`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(joined.body.data.status).toBe("waiting_approval");
    // The name is resolved from their account — they never typed one.
    expect(joined.body.data.name).toBe("Ada Lovelace");
    expect(joined.body.data.userId).toBe(userId);

    // Asking twice is idempotent, not an error.
    const again = await request(app)
      .post(`/api/v1/teams/${teamId}/join`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(again.body.data.id).toBe(joined.body.data.id);

    await request(app)
      .patch(`/api/v1/teams/${teamId}/members/${joined.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "approved" });

    // Approved members see the team under "my teams" — the thing a localStorage store could
    // never do, since a membership row had no real account link.
    const mine = await request(app)
      .get("/api/v1/teams")
      .set("Authorization", `Bearer ${riderToken}`);
    expect(mine.body.data).toHaveLength(1);
  });

  it("404s a team to someone with no connection to it", async () => {
    const app = createApp();
    const { token: ownerToken } = await signIn(app, "team-owner-4");
    const { token: strangerToken } = await signIn(app, "team-stranger");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Private club" });

    const res = await request(app)
      .get(`/api/v1/teams/${team.body.data.id}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(404);
  });

  it("links a ride into a team's schedule, and unlinks it", async () => {
    const app = createApp();
    const { token } = await signIn(app, "team-schedule-owner");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Club" });
    const event = await createEvent(app, token);

    const linked = await request(app)
      .patch(`/api/v1/events/${event.id}/team`)
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId: team.body.data.id });
    expect(linked.status).toBe(200);

    const detail = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.body.data.teamId).toBe(team.body.data.id);

    await request(app)
      .patch(`/api/v1/events/${event.id}/team`)
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId: null });
    const after = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.data.teamId).toBeNull();
  });

  it("refuses to file someone else's ride under your team", async () => {
    const app = createApp();
    const { token: mine } = await signIn(app, "team-mine");
    const { token: theirs } = await signIn(app, "team-theirs");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${mine}`)
      .send({ name: "My club" });
    const theirEvent = await createEvent(app, theirs);

    const res = await request(app)
      .patch(`/api/v1/events/${theirEvent.id}/team`)
      .set("Authorization", `Bearer ${mine}`)
      .send({ teamId: team.body.data.id });
    expect(res.status).toBe(403);
  });

  it("unlinks a team's rides when the team is deleted, rather than orphaning them", async () => {
    const app = createApp();
    const { token } = await signIn(app, "team-delete-owner");
    const team = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Doomed" });
    const event = await createEvent(app, token);
    await request(app)
      .patch(`/api/v1/events/${event.id}/team`)
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId: team.body.data.id });

    await request(app)
      .delete(`/api/v1/teams/${team.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);

    // No foreign keys in this schema, so nothing else would have cleaned this up.
    const detail = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.teamId).toBeNull();
  });
});

describe("following an organizer", () => {
  it("shows their upcoming public rides under filter=following", async () => {
    const app = createApp();
    const { token: organizerToken, userId: organizerId } = await signIn(app, "followed-organizer");
    const { token: riderToken } = await signIn(app, "follower");

    const open = await createEvent(app, organizerToken, { name: "Next Saturday" });
    await publish(app, organizerToken, open.id);
    const secret = await createEvent(app, organizerToken, {
      name: "Private one",
      visibility: "private",
    });
    await publish(app, organizerToken, secret.id);

    const before = await request(app)
      .get("/api/v1/events?filter=following")
      .set("Authorization", `Bearer ${riderToken}`);
    expect(before.body.data).toHaveLength(0);

    await request(app)
      .put(`/api/v1/users/${organizerId}/follow`)
      .set("Authorization", `Bearer ${riderToken}`);

    const after = await request(app)
      .get("/api/v1/events?filter=following")
      .set("Authorization", `Bearer ${riderToken}`);
    // Following someone is not an invitation to their private rides.
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].name).toBe("Next Saturday");
  });

  it("is idempotent, reversible, and counts followers", async () => {
    const app = createApp();
    const { userId: organizerId } = await signIn(app, "counted-organizer");
    const { token: riderToken } = await signIn(app, "counting-follower");

    for (let i = 0; i < 2; i++) {
      await request(app)
        .put(`/api/v1/users/${organizerId}/follow`)
        .set("Authorization", `Bearer ${riderToken}`);
    }
    const following = await request(app)
      .get("/api/v1/users/me/following")
      .set("Authorization", `Bearer ${riderToken}`);
    expect(following.body.data.following).toEqual([organizerId]);

    await request(app)
      .delete(`/api/v1/users/${organizerId}/follow`)
      .set("Authorization", `Bearer ${riderToken}`);
    const after = await request(app)
      .get("/api/v1/users/me/following")
      .set("Authorization", `Bearer ${riderToken}`);
    expect(after.body.data.following).toEqual([]);
  });

  it("refuses to let someone follow themselves", async () => {
    const app = createApp();
    const { token, userId } = await signIn(app, "self-follower");
    const res = await request(app)
      .put(`/api/v1/users/${userId}/follow`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("free-plan limits", () => {
  it("caps teams per owner", async () => {
    const app = createApp();
    const { token } = await signIn(app, "limit-teams");

    for (let i = 0; i < FREE_PLAN.limits.teamsPerOwner; i++) {
      const ok = await request(app)
        .post("/api/v1/teams")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: `Club ${i}` });
      expect(ok.status).toBe(201);
    }

    const overLimit = await request(app)
      .post("/api/v1/teams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "One too many" });
    // 409, not 403: they are permitted, they have run out of allowance.
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.message).toContain("PLAN_LIMIT_TEAMS");
  });

  it("caps ride groups per event", async () => {
    const app = createApp();
    const { token } = await signIn(app, "limit-groups");
    const event = await createEvent(app, token);

    for (let i = 0; i < FREE_PLAN.limits.groupsPerEvent; i++) {
      const ok = await request(app)
        .post(`/api/v1/events/${event.id}/groups`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: `Group ${i}` });
      expect(ok.status).toBe(201);
    }

    const overLimit = await request(app)
      .post(`/api/v1/events/${event.id}/groups`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fifth" });
    expect(overLimit.status).toBe(409);
  });

  it("caps rides per rolling week", async () => {
    const app = createApp();
    const { token } = await signIn(app, "limit-events");

    for (let i = 0; i < FREE_PLAN.limits.eventsPerWeek; i++) {
      const ok = await request(app)
        .post("/api/v1/events")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: `Ride ${i}` });
      expect(ok.status).toBe(201);
    }

    const overLimit = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "One too many" });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.message).toContain("PLAN_LIMIT_EVENTS_PER_WEEK");
  });

  it("refuses an import that would take the start list over the cap, importing none of it", async () => {
    const app = createApp();
    const { token } = await signIn(app, "limit-riders");
    const event = await createEvent(app, token);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/participants/import`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        participants: Array.from({ length: FREE_PLAN.limits.participantsPerEvent + 1 }, (_, i) => ({
          name: `Rider ${i}`,
        })),
      });

    expect(res.status).toBe(409);
    // Importing the first 200 of 201 rows would leave the organizer worse off than a refusal.
    const list = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(0);
  });
});
