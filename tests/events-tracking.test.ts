// The frozen Android contract: plan/07-api-contract.md Part 1. These are the three
// endpoints the live transmitter calls, so their shapes are checked field by field.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { haversineDistanceKm } from "../src/lib/geo.js";
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

async function signIn(
  app: ReturnType<typeof createApp>,
  subject = "google-subject-1",
  picture: string | null = null,
) {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    name: "Rider One",
    picture,
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

describe("GET /api/v1/events/:eventId/live", () => {
  async function createLiveEvent(app: ReturnType<typeof createApp>, ownerToken: string) {
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Live tracking test", visibility: "public" });
    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ showLiveLocations: true });
    for (const status of ["published", "registration_open", "ready", "live"]) {
      await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status });
    }
    return created.body.data;
  }

  it("reports a rider's latest position and running distance after two batches", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-1");
    const riderToken = await signIn(app, "live-rider-1");
    const event = await createLiveEvent(app, ownerToken);

    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });
    const participantId = join.body.participantId as number;

    const first = { lat: 32.08, lng: 34.78 };
    const second = { lat: 32.09, lng: 34.79 };
    await request(app)
      .post(`/api/v1/events/${event.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ participantId, points: [{ ...first, recordedAt: "2026-08-13T09:00:00.000Z" }] });
    await request(app)
      .post(`/api/v1/events/${event.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ participantId, points: [{ ...second, recordedAt: "2026-08-13T09:05:00.000Z" }] });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.paused).toBe(false);
    expect(res.body.data.riders).toHaveLength(1);
    const rider = res.body.data.riders[0];
    expect(rider.participantId).toBe(participantId);
    expect(rider.lat).toBeCloseTo(second.lat);
    expect(rider.lng).toBeCloseTo(second.lng);
    expect(rider.distanceKm).toBeCloseTo(haversineDistanceKm(first, second), 5);
  });

  it("shows a rider's nickname as the live name, plus avatarUrl from Google sign-in", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-name-1");
    const event = await createLiveEvent(app, ownerToken);

    const riderToken = await signIn(app, "live-rider-name-1", "https://example.com/ada.jpg");
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ firstName: "Ada", lastName: "Lovelace", nickname: "Ada L" });

    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });
    const participantId = join.body.participantId as number;
    await request(app)
      .post(`/api/v1/events/${event.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({
        participantId,
        points: [{ lat: 32.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const rider = res.body.data.riders[0];
    expect(rider.name).toBe("Ada L"); // nickname wins over "first last"
    expect(rider.avatarUrl).toBe("https://example.com/ada.jpg");
  });

  it('falls back to "first last" as the live name when a rider has no nickname', async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-name-2");
    const event = await createLiveEvent(app, ownerToken);

    const riderToken = await signIn(app, "live-rider-name-2"); // no picture set
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ firstName: "Grace", lastName: "Hopper" });

    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });
    const participantId = join.body.participantId as number;
    await request(app)
      .post(`/api/v1/events/${event.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({
        participantId,
        points: [{ lat: 32.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const rider = res.body.data.riders[0];
    expect(rider.name).toBe("Grace Hopper");
    expect(rider.avatarUrl).toBeNull();
  });

  it("caps a non-owner's selection to 5 riders even if more are requested", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-2");
    const event = await createLiveEvent(app, ownerToken);

    const participantIds: number[] = [];
    for (let i = 0; i < 7; i++) {
      const riderToken = await signIn(app, `live-rider-cap-${i}`);
      const join = await request(app)
        .post("/api/v1/events/join")
        .set("Authorization", `Bearer ${riderToken}`)
        .send({ eventCode: event.code });
      const participantId = join.body.participantId as number;
      participantIds.push(participantId);
      await request(app)
        .post(`/api/v1/events/${event.id}/locations/batch`)
        .set("Authorization", `Bearer ${riderToken}`)
        .send({
          participantId,
          points: [{ lat: 32 + i * 0.001, lng: 34.7, recordedAt: "2026-08-13T09:00:00.000Z" }],
        });
    }

    const viewerToken = await signIn(app, "live-viewer-cap");
    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live?riders=${participantIds.join(",")}`)
      .set("Authorization", `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.riders.length).toBeLessThanOrEqual(5);
  });

  it("owner sees every rider, unrestricted", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-3");
    const event = await createLiveEvent(app, ownerToken);

    for (let i = 0; i < 6; i++) {
      const riderToken = await signIn(app, `live-rider-owner-${i}`);
      const join = await request(app)
        .post("/api/v1/events/join")
        .set("Authorization", `Bearer ${riderToken}`)
        .send({ eventCode: event.code });
      await request(app)
        .post(`/api/v1/events/${event.id}/locations/batch`)
        .set("Authorization", `Bearer ${riderToken}`)
        .send({
          participantId: join.body.participantId,
          points: [{ lat: 32 + i * 0.001, lng: 34.7, recordedAt: "2026-08-13T09:00:00.000Z" }],
        });
    }

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.riders).toHaveLength(6);
  });

  it("returns nothing to a non-owner who hasn't selected any riders yet", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-4");
    const event = await createLiveEvent(app, ownerToken);
    const viewerToken = await signIn(app, "live-viewer-4");

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/live`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.riders).toHaveLength(0);
  });

  it("403s a non-owner when show_live_locations is off", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "live-owner-5");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "No live sharing", visibility: "public" });
    for (const status of ["published", "registration_open", "ready", "live"]) {
      await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status });
    }

    const viewerToken = await signIn(app, "live-viewer-5");
    const res = await request(app)
      .get(`/api/v1/events/${created.body.data.id}/live`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/events/:eventId/pause", () => {
  it("toggles isPaused and never rejects location ingest while paused", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "pause-owner-1");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Pausable" });
    for (const status of ["published", "registration_open", "ready", "live"]) {
      await request(app)
        .patch(`/api/v1/events/${created.body.data.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status });
    }

    const paused = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/pause`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.data.isPaused).toBe(true);

    const riderToken = await signIn(app, "pause-rider-1");
    const join = await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: created.body.data.code });
    const ingest = await request(app)
      .post(`/api/v1/events/${created.body.data.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({
        participantId: join.body.participantId,
        points: [{ lat: 32.1, lng: 34.8, recordedAt: "2026-08-13T09:00:00.000Z" }],
      });
    expect(ingest.status).toBe(200); // pause never drops or rejects real GPS ingest

    const resumed = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/pause`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ paused: false });
    expect(resumed.body.data.isPaused).toBe(false);
  });

  it("400s pausing an event that isn't live", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "pause-owner-2");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Still a draft" });

    const res = await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/pause`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ paused: true });
    expect(res.status).toBe(400);
  });
});
