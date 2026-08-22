// Results and history: marking attendance and finishers, the results read, and the finish
// hook that turns raw GPS into the saved ride lines.
//
// The finish hook is the one worth staring at. location_points is purge-eligible and
// participant_tracks is never purged — if the hook does not run, that ride's history is gone
// the moment the purge does.

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
  return res.body.accessToken as string;
}

const START = "2026-08-15T05:00:00.000Z";

/** A public event, taken all the way to live, so riders can join and transmit. */
async function liveEvent(app: App, ownerToken: string, overrides: Record<string, unknown> = {}) {
  const created = await request(app)
    .post("/api/v1/events")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "Saturday Ride", visibility: "public", startsAt: START, ...overrides });
  for (const status of ["published", "registration_open", "ready", "live"]) {
    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status });
  }
  return created.body.data;
}

async function joinAs(app: App, event: { id: string; code: string }, token: string) {
  const join = await request(app)
    .post("/api/v1/events/join")
    .set("Authorization", `Bearer ${token}`)
    .send({ eventCode: event.code });
  return join.body.participantId as number;
}

function finish(
  app: App,
  eventId: string,
  ownerToken: string,
  participantId: number,
  body: Record<string, unknown>,
) {
  return request(app)
    .patch(`/api/v1/events/${eventId}/participants/${participantId}/result`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send(body);
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("PATCH …/participants/:id/attendance", () => {
  it("records who turned up without touching the other two axes", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "att-owner");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "att-rider");
    const participantId = await joinAs(app, event, riderToken);

    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${participantId}/attendance`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "present" });

    expect(res.status).toBe(200);
    expect(res.body.data.attendanceStatus).toBe("present");
    // Three independent axes — marking someone present says nothing about the other two.
    expect(res.body.data.registrationStatus).toBe("registered");
    expect(res.body.data.resultStatus).toBe("none");
  });

  it("403s a rider marking their own attendance", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "att-owner-2");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "att-rider-2");
    const participantId = await joinAs(app, event, riderToken);

    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${participantId}/attendance`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ status: "present" });
    expect(res.status).toBe(403);
  });

  it("rejects a status outside the attendance axis", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "att-owner-3");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "att-rider-3");
    const participantId = await joinAs(app, event, riderToken);

    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${participantId}/attendance`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "finished" }); // a result status, not an attendance one
    expect(res.status).toBe(400);
  });
});

describe("PATCH …/participants/:id/result", () => {
  it("stamps finishedAt itself when the organizer just taps Finished", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "res-owner");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "res-rider");
    const participantId = await joinAs(app, event, riderToken);

    const res = await finish(app, event.id, ownerToken, participantId, { status: "finished" });

    expect(res.body.data.resultStatus).toBe("finished");
    expect(res.body.data.finishedAt).not.toBeNull();
  });

  it("clears the finish time and place when a finisher is corrected to DNF", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "res-owner-2");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "res-rider-2");
    const participantId = await joinAs(app, event, riderToken);

    await finish(app, event.id, ownerToken, participantId, {
      status: "finished",
      finishPosition: 1,
    });
    const corrected = await finish(app, event.id, ownerToken, participantId, { status: "dnf" });

    // A DNF that kept a finish time would stay in the ranking forever.
    expect(corrected.body.data.resultStatus).toBe("dnf");
    expect(corrected.body.data.finishedAt).toBeNull();
    expect(corrected.body.data.finishPosition).toBeNull();
  });
});

describe("GET /api/v1/events/:eventId/results", () => {
  /** Three riders home at 1h, 1h02 and 1h05; a fourth abandons. */
  async function riddenEvent(app: App, overrides: Record<string, unknown> = {}) {
    const ownerToken = await signIn(app, "results-owner", "Dani", "Cohen");
    const event = await liveEvent(app, ownerToken, overrides);

    const riders = [
      { subject: "r-first", first: "Ada", finishedAt: "2026-08-15T06:00:00.000Z" },
      { subject: "r-second", first: "Bea", finishedAt: "2026-08-15T06:02:00.000Z" },
      { subject: "r-third", first: "Cai", finishedAt: "2026-08-15T06:05:00.000Z" },
    ];
    const ids: Record<string, number> = {};
    for (const rider of riders) {
      const token = await signIn(app, rider.subject, rider.first, "Rider");
      ids[rider.subject] = await joinAs(app, event, token);
      await finish(app, event.id, ownerToken, ids[rider.subject], {
        status: "finished",
        finishedAt: rider.finishedAt,
      });
    }

    const dnfToken = await signIn(app, "r-dnf", "Dee", "Rider");
    ids["r-dnf"] = await joinAs(app, event, dnfToken);
    await finish(app, event.id, ownerToken, ids["r-dnf"], { status: "dnf" });

    return { ownerToken, event, ids };
  }

  it("ranks finishers, times them from the event start, and gaps them to the leader", async () => {
    const app = createApp();
    const { ownerToken, event } = await riddenEvent(app);

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const riders = res.body.data.riders;
    expect(riders).toHaveLength(4);

    expect(riders[0].name).toBe("Ada Rider");
    expect(riders[0].overallPlace).toBe(1);
    expect(riders[0].totalTime).toBe("1:00:00");
    // The leader is not behind anyone — null, never "+0:00".
    expect(riders[0].gap).toBeNull();

    expect(riders[1].overallPlace).toBe(2);
    expect(riders[1].totalTime).toBe("1:02:00");
    expect(riders[1].gap).toBe("+2:00");

    expect(riders[2].gap).toBe("+5:00");

    // Non-finishers sort after every finisher and have no place.
    expect(riders[3].status).toBe("dnf");
    expect(riders[3].overallPlace).toBeNull();
    expect(riders[3].totalTime).toBeNull();
  });

  it("computes category places at read time, within each category", async () => {
    const app = createApp();
    const { ownerToken, event, ids } = await riddenEvent(app);

    // 1st and 3rd overall share a category; 2nd is in another.
    await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${ids["r-first"]}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Masters" });
    await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${ids["r-third"]}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Masters" });
    await request(app)
      .patch(`/api/v1/events/${event.id}/participants/${ids["r-second"]}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Elite" });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const byId = new Map(res.body.data.riders.map((r: { id: string }) => [r.id, r]));

    expect(byId.get(String(ids["r-first"]))).toMatchObject({ overallPlace: 1, categoryPlace: 1 });
    // Third overall, but the second Master home.
    expect(byId.get(String(ids["r-third"]))).toMatchObject({ overallPlace: 3, categoryPlace: 2 });
    // Alone in their category, so first in it despite being second overall.
    expect(byId.get(String(ids["r-second"]))).toMatchObject({ overallPlace: 2, categoryPlace: 1 });
  });

  it("lets a hand-set finish position beat the clock", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "manual-owner");
    const event = await liveEvent(app, ownerToken);

    const slowToken = await signIn(app, "slow-rider", "Slow");
    const fastToken = await signIn(app, "fast-rider", "Fast");
    const slowId = await joinAs(app, event, slowToken);
    const fastId = await joinAs(app, event, fastToken);

    // Fast crossed first, but the organizer at the line recorded Slow as the winner.
    await finish(app, event.id, ownerToken, fastId, {
      status: "finished",
      finishedAt: "2026-08-15T06:00:00.000Z",
    });
    await finish(app, event.id, ownerToken, slowId, {
      status: "finished",
      finishedAt: "2026-08-15T06:10:00.000Z",
      finishPosition: 1,
    });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.riders[0].id).toBe(String(slowId));
  });

  it("names the real organizer instead of leaving the client to invent one", async () => {
    const app = createApp();
    const { ownerToken, event } = await riddenEvent(app);
    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.organizer.name).toBe("Dani Cohen");
  });

  it("leaves out riders who were rejected — they were never in the ride", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "rej-owner");
    const event = await liveEvent(app, ownerToken, { requiresApproval: true });
    const riderToken = await signIn(app, "rej-rider");
    const participantId = await joinAs(app, event, riderToken);
    await request(app)
      .post(`/api/v1/events/${event.id}/participants/${participantId}/reject`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.riders).toHaveLength(0);
  });

  it("carries the event's route, preview only", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "res-route-owner");
    const event = await liveEvent(app, ownerToken);
    const route = await request(app)
      .post("/api/v1/routes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "The loop",
        points: [
          { lat: 32.81, lng: 35.53 },
          { lat: 32.83, lng: 35.55 },
        ],
      });
    await request(app)
      .post(`/api/v1/events/${event.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: route.body.data.id });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.data.route.previewPoints).toHaveLength(2);
    expect(res.body.data.route.trackPoints).toBeUndefined();
  });

  it("403s a public event whose organizer closed results", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "hidden-owner");
    const event = await liveEvent(app, ownerToken, { showResults: false });

    const asGuest = await request(app).get(`/api/v1/events/${event.id}/results`);
    expect(asGuest.status).toBe(403);

    const asOwner = await request(app)
      .get(`/api/v1/events/${event.id}/results`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(asOwner.status).toBe(200);
  });
});

describe("the finish hook", () => {
  /** One rider transmitting four points, then the organizer stopping the ride. */
  async function ridePlusFinish(app: App) {
    const ownerToken = await signIn(app, "hook-owner");
    const event = await liveEvent(app, ownerToken);
    const riderToken = await signIn(app, "hook-rider", "Ada");
    const participantId = await joinAs(app, event, riderToken);

    await request(app)
      .post(`/api/v1/events/${event.id}/locations/batch`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({
        participantId,
        points: [
          { lat: 32.0, lng: 34.7, recordedAt: "2026-08-15T05:10:00.000Z" },
          { lat: 32.01, lng: 34.71, recordedAt: "2026-08-15T05:20:00.000Z" },
          { lat: 32.02, lng: 34.72, recordedAt: "2026-08-15T05:30:00.000Z", emergency: true },
          { lat: 32.03, lng: 34.73, recordedAt: "2026-08-15T05:40:00.000Z" },
        ],
      });

    return { ownerToken, riderToken, event, participantId };
  }

  it("saves each rider's line when the organizer finishes the ride", async () => {
    const app = createApp();
    const { ownerToken, event, participantId } = await ridePlusFinish(app);

    // Nothing saved while the ride is still running.
    const before = await request(app)
      .get(`/api/v1/events/${event.id}/tracks`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(before.body.data).toHaveLength(0);

    await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "finished" });

    const after = await request(app)
      .get(`/api/v1/events/${event.id}/tracks`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.data).toHaveLength(1);
    const track = after.body.data[0];
    expect(track.participantId).toBe(participantId);
    expect(track.points).toHaveLength(4);
    expect(track.pointCount).toBe(4);
    expect(track.distanceKm).toBeGreaterThan(0);
    expect(track.startedAt).toBe("2026-08-15T05:10:00.000Z");
    expect(track.endedAt).toBe("2026-08-15T05:40:00.000Z");
    // One point had SOS set, so the whole ride is flagged.
    expect(track.hadEmergency).toBe(true);
  });

  it("does not blow up, or lose the ride, when there was no GPS at all", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "empty-owner");
    const event = await liveEvent(app, ownerToken);

    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "finished" });

    // Finishing is the organizer's action and must succeed regardless.
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("finished");
  });

  it("shows a rider their own line even when history is closed to everyone else", async () => {
    const app = createApp();
    const { ownerToken, riderToken, event, participantId } = await ridePlusFinish(app);
    await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "finished" });

    // show_history_locations defaults to FALSE — where someone rode is their route home.
    const listed = await request(app)
      .get(`/api/v1/events/${event.id}/tracks`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(listed.status).toBe(403);

    const mine = await request(app)
      .get(`/api/v1/events/${event.id}/tracks/${participantId}`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.participantId).toBe(participantId);
  });

  it("opens the history to everyone once the organizer shares it", async () => {
    const app = createApp();
    const { ownerToken, riderToken, event } = await ridePlusFinish(app);
    await request(app)
      .patch(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ showHistoryLocations: true });
    await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "finished" });

    const res = await request(app)
      .get(`/api/v1/events/${event.id}/tracks`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
