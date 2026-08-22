// Ownership, CRUD and the status workflow — milestone 2. The three frozen transmitter
// endpoints have their own coverage in events-tracking.test.ts; this file is everything
// added around them.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb, seedEvent } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/lib/google-auth.js", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  InvalidGoogleTokenError: class InvalidGoogleTokenError extends Error {},
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

const { createApp } = await import("../src/app.js");

async function signIn(
  app: ReturnType<typeof createApp>,
  subject: string,
  picture: string | null = null,
) {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    name: "Test User",
    picture,
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body.accessToken as string;
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("POST /api/v1/events", () => {
  it("creates a draft event owned by the caller", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-1");

    const res = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Saturday Gravel Ride" });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Saturday Gravel Ride");
    expect(res.body.data.status).toBe("draft");
    expect(res.body.data.type).toBe("RIDE");
    expect(res.body.data.isOwner).toBe(true);
    expect(typeof res.body.data.code).toBe("string");
    // Fresh sign-in leaves first/last/nickname unset — the client falls back on null itself.
    expect(res.body.data.ownerName).toBeNull();
  });

  it("requires an access token", async () => {
    const res = await request(createApp()).post("/api/v1/events").send({ name: "No auth" });
    expect(res.status).toBe(401);
  });

  it("rejects a missing name", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-2");
    const res = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/events", () => {
  it("filters mine vs joined", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-3");
    const riderToken = await signIn(app, "rider-3");

    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Owned Event" });

    // Publish it so it is joinable, then have the rider join.
    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "published" });
    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: created.body.data.code });

    const mine = await request(app)
      .get("/api/v1/events?filter=mine")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(mine.body.data).toHaveLength(1);

    const joined = await request(app)
      .get("/api/v1/events?filter=joined")
      .set("Authorization", `Bearer ${riderToken}`);
    expect(joined.body.data).toHaveLength(1);
    expect(joined.body.data[0].id).toBe(created.body.data.id);

    const ownerJoined = await request(app)
      .get("/api/v1/events?filter=joined")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerJoined.body.data).toHaveLength(0);
  });

  it("includes the owner's display name, preferring nickname over first/last", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-name-1");
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ firstName: "Ada", lastName: "Lovelace" });

    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Named Owner Event" });
    expect(created.body.data.ownerName).toBe("Ada Lovelace");

    const list = await request(app)
      .get("/api/v1/events?filter=mine")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body.data[0].ownerName).toBe("Ada Lovelace");

    // Nickname wins once set, everywhere ownerName is read from — proves it's computed
    // fresh on read rather than snapshotted at event-creation time.
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ nickname: "Countess" });

    const detail = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.data.ownerName).toBe("Countess");
  });

  it("includes the owner's avatarUrl from Google sign-in, null until they have one", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-avatar-1"); // no picture set

    const noAvatar = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Ownerless Avatar" });
    expect(noAvatar.body.data.ownerAvatarUrl).toBeNull();

    const withAvatarToken = await signIn(app, "owner-avatar-2", "https://example.com/owner.jpg");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${withAvatarToken}`)
      .send({ name: "Named Owner Avatar Event" });
    expect(created.body.data.ownerAvatarUrl).toBe("https://example.com/owner.jpg");

    const list = await request(app)
      .get("/api/v1/events?filter=mine")
      .set("Authorization", `Bearer ${withAvatarToken}`);
    expect(list.body.data[0].ownerAvatarUrl).toBe("https://example.com/owner.jpg");

    const detail = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${withAvatarToken}`);
    expect(detail.body.data.ownerAvatarUrl).toBe("https://example.com/owner.jpg");
  });
});

describe("GET /api/v1/events/public", () => {
  it("lists only public, non-draft, non-cancelled events, unauthenticated", async () => {
    seedEvent({ id: "a", code: "A", name: "Public live", status: "live", visibility: "public" });
    seedEvent({ id: "b", code: "B", name: "Private live", status: "live", visibility: "private" });
    seedEvent({ id: "c", code: "C", name: "Public draft", status: "draft", visibility: "public" });

    const res = await request(createApp()).get("/api/v1/events/public");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("a");
  });

  it("surfaces the owner's display name on public list items too, not just the detail page", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-pub-1");
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ firstName: "Grace", lastName: "Hopper" });

    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Public With Owner", visibility: "public" });
    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "published" });

    const res = await request(app).get("/api/v1/events/public");
    const item = res.body.data.find((e: { id: string }) => e.id === created.body.data.id);
    expect(item.ownerName).toBe("Grace Hopper");
  });
});

describe("GET /api/v1/events/:eventId", () => {
  it("403s a private event for a non-owner", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-4");
    const otherToken = await signIn(app, "other-4");

    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Private Event", visibility: "private" });

    const res = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("404s an unknown event", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-5");
    const res = await request(app)
      .get("/api/v1/events/11111111-1111-4111-8111-111111111111")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  // Guest browsing (GET /events/public, unauthenticated) leads here — tapping a public
  // event's card must not suddenly demand a login just to look.
  it("lets an anonymous viewer read a public event", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-6");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Public Event", visibility: "public" });

    const res = await request(app).get(`/api/v1/events/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Public Event");
    expect(res.body.data.isOwner).toBe(false);
  });

  it("still 403s a private event for an anonymous viewer", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-7");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Private Event", visibility: "private" });

    const res = await request(app).get(`/api/v1/events/${created.body.data.id}`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/events/:eventId", () => {
  it("403s a non-owner edit", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-6");
    const otherToken = await signIn(app, "other-6");

    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Owned" });

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(403);
  });

  it("updates fields the owner sends and leaves the rest alone", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-7");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Original", location: "Tel Aviv" });

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed");
    expect(res.body.data.location).toBe("Tel Aviv");
  });

  it("400s an edit while the event is live — Manage mode only, not general details", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-14");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Going live" });
    for (const status of ["published", "registration_open", "ready", "live"]) {
      await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sneaky rename" });
    expect(res.status).toBe(400);
  });

  it("400s an edit once the event has finished", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-15");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Will finish" });
    for (const status of ["published", "registration_open", "ready", "live", "finished"]) {
      await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
    }

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Too late" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/events/:eventId/status", () => {
  it("walks the happy path draft -> published -> registration_open -> ready -> live -> finished", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-8");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lifecycle" });

    const path = ["published", "registration_open", "ready", "live", "finished"];
    let status = 0;
    for (const next of path) {
      const res = await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: next });
      status = res.status;
      expect(res.body.data.status).toBe(next);
    }
    expect(status).toBe(200);
  });

  it("rejects skipping a step", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-9");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Skip" });

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "live" });
    expect(res.status).toBe(400);
  });

  async function walkToLive(app: ReturnType<typeof createApp>, token: string, name: string) {
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name });
    let latest = created.body.data;
    for (const status of ["published", "registration_open", "ready", "live"]) {
      const res = await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
      latest = res.body.data;
    }
    return latest;
  }

  it("409s starting a (limit + 1)th live event — free tier caps concurrent live events at 2", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-12");
    await walkToLive(app, token, "First live event");
    await walkToLive(app, token, "Second live event");

    const third = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Third event" });
    await request(app)
      .patch(`/api/v1/events/${third.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "published" });
    await request(app)
      .patch(`/api/v1/events/${third.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "registration_open" });
    await request(app)
      .patch(`/api/v1/events/${third.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ready" });

    const res = await request(app)
      .patch(`/api/v1/events/${third.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "live" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/limit is 2/);
  });

  it("does not block a different owner from going live at the same time", async () => {
    const app = createApp();
    const tokenA = await signIn(app, "owner-13a");
    const tokenB = await signIn(app, "owner-13b");
    await walkToLive(app, tokenA, "Owner A's event");
    const eventB = await walkToLive(app, tokenB, "Owner B's event");
    expect(eventB.status).toBe("live");
  });

  it("sets is_active false for a draft and true once published, matching by-code lookup", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-10");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Findable" });

    const beforePublish = await request(app).get(
      `/api/v1/events/by-code/${created.body.data.code}`,
    );
    expect(beforePublish.status).toBe(404);

    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "published" });

    const afterPublish = await request(app).get(`/api/v1/events/by-code/${created.body.data.code}`);
    expect(afterPublish.status).toBe(200);
  });
});

describe("DELETE /api/v1/events/:eventId", () => {
  it("soft-deletes: the event still exists but is cancelled, not gone", async () => {
    const app = createApp();
    const token = await signIn(app, "owner-11");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cancel me" });

    const del = await request(app)
      .delete(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe("cancelled");

    const stillThere = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.data.status).toBe("cancelled");
  });
});
