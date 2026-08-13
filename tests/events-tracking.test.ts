// The frozen Android contract: plan/07-api-contract.md Part 1. These are the three
// endpoints the live transmitter calls, so their shapes are checked field by field.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb, seedEvent, storedLocationPoints } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/lib/google-auth.js", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  InvalidGoogleTokenError: class InvalidGoogleTokenError extends Error {},
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

const { createApp } = await import("../src/app.js");

const RIDE_ID = "11111111-1111-4111-8111-111111111111";
const RACE_ID = "22222222-2222-4222-8222-222222222222";

async function signIn(app: ReturnType<typeof createApp>, subject = "google-subject-1") {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    name: "Rider One",
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body.accessToken as string;
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
  seedEvent({ id: RIDE_ID, code: "13082026A", name: "Saturday Gravel Ride" });
  seedEvent({
    id: RACE_ID,
    code: "13082026B",
    name: "Gravel Championship",
    type: "RACE",
    requiresBib: true,
  });
});

describe("GET /api/v1/events/by-code/:code", () => {
  it("returns the event config without a token", async () => {
    const res = await request(createApp()).get("/api/v1/events/by-code/13082026A");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eventId: RIDE_ID,
      name: "Saturday Gravel Ride",
      type: "RIDE",
      requiresBib: false,
    });
  });

  it("returns 404 for an unknown code", async () => {
    const res = await request(createApp()).get("/api/v1/events/by-code/99999999Z");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an inactive event", async () => {
    seedEvent({
      id: "33333333-3333-4333-8333-333333333333",
      code: "13082026C",
      name: "Cancelled",
      isActive: false,
    });
    const res = await request(createApp()).get("/api/v1/events/by-code/13082026C");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/events/join", () => {
  it("returns a participantId and the event config", async () => {
    const app = createApp();
    const accessToken = await signIn(app);

    const res = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026A" });

    expect(res.status).toBe(200);
    expect(res.body.eventId).toBe(RIDE_ID);
    expect(res.body.participantId).toEqual(expect.any(Number));
    expect(res.body.eventName).toBe("Saturday Gravel Ride");
    expect(res.body.eventType).toBe("RIDE");
    expect(res.body.requiresBib).toBe(false);
  });

  it("is idempotent — re-joining keeps the same participantId", async () => {
    const app = createApp();
    const accessToken = await signIn(app);

    const first = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026A" });
    const second = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026A" });

    expect(second.status).toBe(200);
    expect(second.body.participantId).toBe(first.body.participantId);
  });

  it("keeps the existing bib when a re-join sends none", async () => {
    const app = createApp();
    const accessToken = await signIn(app);

    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026B", bib: "42" });
    const rejoin = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026B", bib: "42" });

    expect(rejoin.status).toBe(200);
  });

  it("rejects a bib-required event joined without a bib", async () => {
    const app = createApp();
    const accessToken = await signIn(app);

    const res = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026B" });

    expect(res.status).toBe(400);
  });

  it("requires an access token", async () => {
    const res = await request(createApp())
      .post("/api/v1/events/join")
      .send({ eventCode: "13082026A" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/events/:eventId/locations/batch", () => {
  async function joinRide(app: ReturnType<typeof createApp>, subject?: string) {
    const accessToken = await signIn(app, subject);
    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ eventCode: "13082026A" });
    return { accessToken, participantId: join.body.participantId as number };
  }

  it("stores a batch and reports how many were saved", async () => {
    const app = createApp();
    const { accessToken, participantId } = await joinRide(app);

    const res = await request(app)
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        participantId,
        points: [
          { lat: 32.0853, lng: 34.7818, accuracy: 8.5, recordedAt: "2026-08-13T09:14:02.000Z" },
          { lat: 32.0854, lng: 34.782, recordedAt: "2026-08-13T09:14:12.000Z", emergency: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 2 });

    const stored = storedLocationPoints();
    expect(stored).toHaveLength(2);
    expect(stored[0].accuracy).toBe(8.5);
    expect(stored[1].accuracy).toBeNull();
    expect(stored[1].emergency).toBe(true);
  });

  // The whole offline design rests on this: a batch uploaded hours late keeps the time the
  // rider was actually there, not the time the server received it.
  it("keeps the device's recordedAt, separate from received_at", async () => {
    const app = createApp();
    const { accessToken, participantId } = await joinRide(app);
    const recordedAt = "2026-08-12T06:00:00.000Z"; // yesterday: a batch that waited out a dead zone

    await request(app)
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ participantId, points: [{ lat: 32.1, lng: 34.8, recordedAt }] });

    const [point] = storedLocationPoints();
    expect(point.recorded_at.toISOString()).toBe(recordedAt);
    expect(point.received_at.getTime()).toBeGreaterThan(point.recorded_at.getTime());
  });

  it("rejects a participantId that belongs to another rider", async () => {
    const app = createApp();
    const other = await joinRide(app, "google-subject-2");
    const mine = await joinRide(app, "google-subject-3");

    const res = await request(app)
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${mine.accessToken}`)
      .send({
        participantId: other.participantId,
        points: [{ lat: 32.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });

    expect(res.status).toBe(404);
    expect(storedLocationPoints()).toHaveLength(0);
  });

  it("rejects a participant that belongs to a different event", async () => {
    const app = createApp();
    const { accessToken, participantId } = await joinRide(app);

    const res = await request(app)
      .post(`/api/v1/events/${RACE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        participantId,
        points: [{ lat: 32.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });

    expect(res.status).toBe(404);
  });

  it("rejects more than 200 points in one batch", async () => {
    const app = createApp();
    const { accessToken, participantId } = await joinRide(app);
    const points = Array.from({ length: 201 }, () => ({
      lat: 32.1,
      lng: 34.8,
      recordedAt: "2026-08-13T09:00:00.000Z",
    }));

    const res = await request(app)
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ participantId, points });

    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range latitude", async () => {
    const app = createApp();
    const { accessToken, participantId } = await joinRide(app);

    const res = await request(app)
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        participantId,
        points: [{ lat: 132.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });

    expect(res.status).toBe(400);
  });

  it("requires an access token", async () => {
    const res = await request(createApp())
      .post(`/api/v1/events/${RIDE_ID}/locations/batch`)
      .send({ participantId: 1, points: [] });
    expect(res.status).toBe(401);
  });
});
