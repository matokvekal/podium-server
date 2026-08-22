// Routes module: POST/GET /api/v1/events/:eventId/route. Fixes the bug where an event's route
// lived only in client-side localStorage — every other viewer saw a fabricated mock route
// instead of the one the organizer actually picked. See plan/08-routes-and-maps.md.

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

async function createEvent(
  app: ReturnType<typeof createApp>,
  ownerToken: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await request(app)
    .post("/api/v1/events")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "Ride", visibility: "public", ...overrides });
  return created.body.data;
}

const samplePoints: [number, number][] = [
  [32.08, 34.78],
  [32.09, 34.79],
  [32.1, 34.8],
];

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("POST /api/v1/events/:eventId/route", () => {
  it("lets the owner set a route", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-1");
    const event = await createEvent(app, ownerToken);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ points: samplePoints, distanceKm: 12.5, elevationM: 340 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      points: samplePoints,
      distanceKm: 12.5,
      elevationM: 340,
    });
  });

  it("403s a non-owner", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-2");
    const otherToken = await signIn(app, "other-2");
    const event = await createEvent(app, ownerToken);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ points: samplePoints, distanceKm: 12.5 });

    expect(res.status).toBe(403);
  });

  it("401s an anonymous caller", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-2b");
    const event = await createEvent(app, ownerToken);

    const res = await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .send({ points: samplePoints, distanceKm: 12.5 });

    expect(res.status).toBe(401);
  });

  it("replaces the previously saved route rather than accumulating both", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-3");
    const event = await createEvent(app, ownerToken);

    await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ points: samplePoints, distanceKm: 12.5, elevationM: 340 });

    const newPoints: [number, number][] = [
      [10, 20],
      [11, 21],
    ];
    const second = await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ points: newPoints, distanceKm: 3, elevationM: null });
    expect(second.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(get.body.data).toEqual({ points: newPoints, distanceKm: 3, elevationM: null });
  });
});

describe("GET /api/v1/events/:eventId/route", () => {
  it("returns null when no route has been set yet", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-4");
    const event = await createEvent(app, ownerToken);

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("returns the route once it's set, for any viewer of a public event", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-5");
    const viewerToken = await signIn(app, "viewer-5");
    const event = await createEvent(app, ownerToken);

    await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ points: samplePoints, distanceKm: 12.5, elevationM: 340 });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      points: samplePoints,
      distanceKm: 12.5,
      elevationM: 340,
    });
  });

  it("403s a stranger reading a private event's route, same as GET /:eventId", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-6");
    const strangerToken = await signIn(app, "stranger-6");
    const event = await createEvent(app, ownerToken, { visibility: "private" });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${strangerToken}`);

    expect(res.status).toBe(403);
  });

  it("403s an anonymous viewer of a private event's route", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-7");
    const event = await createEvent(app, ownerToken, { visibility: "private" });

    const res = await request(app).get(`/api/v1/events/${event.id}/route`);
    expect(res.status).toBe(403);
  });

  it("404s a nonexistent event", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "owner-8");

    const res = await request(app)
      .get("/api/v1/events/00000000-0000-0000-0000-000000000000/route")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });
});
