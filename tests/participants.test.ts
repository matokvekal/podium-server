// Participants module: manual add/edit/remove, approve/reject, and the "riders list open"
// gate on the list endpoint (event.showParticipants) — see plan/07-api-contract.md.

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

async function signIn(app: ReturnType<typeof createApp>, subject: string) {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    name: "Test User",
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body.accessToken as string;
}

async function createAndPublish(
  app: ReturnType<typeof createApp>,
  ownerToken: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await request(app)
    .post("/api/v1/events")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "Ride", visibility: "public", ...overrides });
  await request(app)
    .patch(`/api/v1/events/${created.body.data.id}/status`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ status: "published" });
  return created.body.data;
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("POST /api/v1/events/:eventId/participants (manual add)", () => {
  it("lets the owner add a rider with no account, approved immediately", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-1");
    const event = await createAndPublish(app, ownerToken);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Walk-in Rider", bib: "7" });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Walk-in Rider");
    expect(res.body.data.registrationStatus).toBe("approved");
  });

  it("403s a non-owner", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-2");
    const otherToken = await signIn(app, "other-2");
    const event = await createAndPublish(app, ownerToken);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hijack" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH and DELETE /api/v1/events/:eventId/participants/:id", () => {
  it("edits and then removes a manually added rider", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-3");
    const event = await createAndPublish(app, ownerToken);
    const added = await request(app)
      .post(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Original Name" });

    const edited = await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${added.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Renamed" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe("Renamed");

    const removed = await request(app)
      .delete(`/api/v1/events/${event.id}/participants/${added.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removed.status).toBe(204);

    const list = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body.data).toHaveLength(0);
  });
});

describe("approval-required registration", () => {
  it("self-join lands as waiting_approval, and the owner can approve it", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-4");
    const riderToken = await signIn(app, "rider-4");
    const event = await createAndPublish(app, ownerToken, { requiresApproval: true });

    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });
    expect(join.status).toBe(200);

    const list = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].registrationStatus).toBe("waiting_approval");

    const approve = await request(app)
      .post(`/api/v1/events/${event.id}/participants/${list.body.data[0].id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.registrationStatus).toBe("approved");
  });

  it("re-joining does not un-approve an already-approved rider", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-5");
    const riderToken = await signIn(app, "rider-5");
    const event = await createAndPublish(app, ownerToken, { requiresApproval: true });

    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const list1 = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/v1/events/${event.id}/participants/${list1.body.data[0].id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    // Re-join, e.g. the app retrying after a dropped connection — must not un-approve.
    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const list2 = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list2.body.data[0].registrationStatus).toBe("approved");
  });

  it("open-join (requiresApproval false) registers immediately", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-6");
    const riderToken = await signIn(app, "rider-6");
    const event = await createAndPublish(app, ownerToken);

    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const list = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body.data[0].registrationStatus).toBe("registered");
  });
});

describe("GET /api/v1/events/:eventId/participants — the riders-list-open gate", () => {
  it("403s a registered rider when the list is not open", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-7");
    const riderToken = await signIn(app, "rider-7");
    const event = await createAndPublish(app, ownerToken); // showParticipants defaults false

    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(res.status).toBe(403);
  });

  it("lets a registered rider see the list once it's open", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-8");
    const riderToken = await signIn(app, "rider-8");
    const event = await createAndPublish(app, ownerToken);

    await request(app)
      .patch(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ showParticipants: true });
    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("401s an anonymous caller", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-9");
    const event = await createAndPublish(app, ownerToken);

    const res = await request(app).get(`/api/v1/events/${event.id}/participants`);
    expect(res.status).toBe(401);
  });
});
