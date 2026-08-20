// The routes module: uploading a track, the public library, and attaching one to a ride.
//
// The rule this file keeps honest is the one from plan/08-routes-and-maps.md: a LIST never
// carries full geometry, only the simplified preview. The route browser paints a dozen map
// previews at once, and track_points is the largest column in the database.

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

async function signIn(app: ReturnType<typeof createApp>, subject: string, firstName = "Test") {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    firstName,
    lastName: "Rider",
    displayName: null,
    picture: null,
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body.accessToken as string;
}

/** A short climb near the Sea of Galilee — 4 points, each 100 m higher than the last. */
const POINTS = [
  { lat: 32.8156, lng: 35.5397, ele: 100 },
  { lat: 32.8301, lng: 35.5512, ele: 200 },
  { lat: 32.8459, lng: 35.5601, ele: 150 },
  { lat: 32.8523, lng: 35.5789, ele: 250 },
];

function createRoute(
  app: ReturnType<typeof createApp>,
  token: string,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post("/api/v1/routes")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Galilee Loop", points: POINTS, ...body });
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("POST /api/v1/routes", () => {
  it("computes distance, climb, bbox and the preview once, at upload", async () => {
    const app = createApp();
    const token = await signIn(app, "route-owner-1");

    const res = await createRoute(app, token, { routeType: "gravel", placeName: "Galilee" });

    expect(res.status).toBe(201);
    const route = res.body.data;
    expect(route.pointCount).toBe(4);
    expect(route.distanceKm).toBeGreaterThan(0);
    // Only the two ascents count: 100→200 and 150→250. The descent is not climb.
    expect(route.elevationM).toBeCloseTo(200);
    expect(route.startLat).toBeCloseTo(POINTS[0].lat);
    expect(route.endLat).toBeCloseTo(POINTS[3].lat);
    expect(route.bbox).toEqual({
      minLat: 32.8156,
      minLon: 35.5397,
      maxLat: 32.8523,
      maxLon: 35.5789,
    });
    // Under the preview target, so the preview is the whole line.
    expect(route.previewPoints).toHaveLength(4);
    expect(route.trackPoints).toHaveLength(4);
  });

  it("reports unknown climb as null rather than zero", async () => {
    const app = createApp();
    const token = await signIn(app, "route-owner-2");

    const res = await createRoute(app, token, {
      points: POINTS.map(({ lat, lng }) => ({ lat, lng })),
    });

    // "Flat" and "we don't know" are different answers, and an elevation filter must not
    // quietly swallow the second.
    expect(res.body.data.elevationM).toBeNull();
    expect(res.body.data.distanceKm).toBeGreaterThan(0);
  });

  it("simplifies a long track down to the preview target", async () => {
    const app = createApp();
    const token = await signIn(app, "route-owner-3");
    const long = Array.from({ length: 1200 }, (_, i) => ({
      lat: 32.8 + i * 0.0001,
      lng: 35.5 + i * 0.0001,
    }));

    const res = await createRoute(app, token, { points: long });

    expect(res.body.data.pointCount).toBe(1200);
    expect(res.body.data.previewPoints).toHaveLength(300);
    // First and last must survive simplification, or the line visibly moves.
    expect(res.body.data.previewPoints[0]).toEqual({ lat: long[0].lat, lng: long[0].lng });
    expect(res.body.data.previewPoints[299]).toEqual({
      lat: long[1199].lat,
      lng: long[1199].lng,
    });
  });

  it("rejects a track with fewer than two points", async () => {
    const app = createApp();
    const token = await signIn(app, "route-owner-4");
    const res = await createRoute(app, token, { points: [POINTS[0]] });
    expect(res.status).toBe(400);
  });

  it("requires a signed-in caller", async () => {
    const res = await request(createApp()).post("/api/v1/routes").send({ points: POINTS });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/routes/:routeId", () => {
  it("opens a published route for a guest with no account", async () => {
    const app = createApp();
    const token = await signIn(app, "route-owner-5", "Dani");
    const created = await createRoute(app, token, { isPublic: true });

    const res = await request(app).get(`/api/v1/routes/${created.body.data.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.trackPoints).toHaveLength(4);
    expect(res.body.data.ownerName).toBe("Dani Rider");
  });

  it("404s an unpublished route for anyone but its owner", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "route-owner-6");
    const otherToken = await signIn(app, "route-other-6");
    const created = await createRoute(app, ownerToken);

    const asStranger = await request(app)
      .get(`/api/v1/routes/${created.body.data.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(asStranger.status).toBe(404);

    const asOwner = await request(app)
      .get(`/api/v1/routes/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(asOwner.status).toBe(200);
  });
});

describe("GET /api/v1/routes/public", () => {
  async function seedLibrary(app: ReturnType<typeof createApp>) {
    const token = await signIn(app, "library-owner");
    await createRoute(app, token, {
      name: "Galilee Loop",
      placeName: "Galilee",
      routeType: "gravel",
      isPublic: true,
    });
    await createRoute(app, token, {
      name: "Ashkelon Flat",
      placeName: "Ashkelon",
      routeType: "road",
      isPublic: true,
      points: POINTS.map(({ lat, lng }) => ({ lat, lng })),
    });
    await createRoute(app, token, { name: "Secret Training Loop", isPublic: false });
    return token;
  }

  it("lists only published routes, and never their full geometry", async () => {
    const app = createApp();
    await seedLibrary(app);

    const res = await request(app).get("/api/v1/routes/public");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    for (const route of res.body.data) {
      expect(route.previewPoints.length).toBeGreaterThan(0);
      // The rule this whole module is shaped around.
      expect(route.trackPoints).toBeUndefined();
    }
  });

  it("filters by place, type and distance", async () => {
    const app = createApp();
    await seedLibrary(app);

    const byPlace = await request(app).get("/api/v1/routes/public?place=galilee");
    expect(byPlace.body.data).toHaveLength(1);
    expect(byPlace.body.data[0].name).toBe("Galilee Loop");

    const byType = await request(app).get("/api/v1/routes/public?type=road");
    expect(byType.body.data).toHaveLength(1);
    expect(byType.body.data[0].name).toBe("Ashkelon Flat");

    const tooLong = await request(app).get("/api/v1/routes/public?minDistance=9999");
    expect(tooLong.body.data).toHaveLength(0);
    expect(tooLong.body.total).toBe(0);
  });

  it("never satisfies an elevation filter with an unknown elevation", async () => {
    const app = createApp();
    await seedLibrary(app);

    // "Ashkelon Flat" was uploaded without elevation, so its climb is unknown, not 0.
    const res = await request(app).get("/api/v1/routes/public?maxElevation=10");
    expect(res.body.data).toHaveLength(0);
  });

  it("pages, and reports the total so the browser can render page numbers", async () => {
    const app = createApp();
    await seedLibrary(app);

    const res = await request(app).get("/api/v1/routes/public?page=1&pageSize=1");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
  });
});

describe("GET /api/v1/routes (my library)", () => {
  it("returns the caller's own routes, published or not", async () => {
    const app = createApp();
    const mine = await signIn(app, "lib-mine");
    await createRoute(app, mine, { name: "Private one" });
    await createRoute(app, mine, { name: "Published one", isPublic: true });
    const theirs = await signIn(app, "lib-theirs");
    await createRoute(app, theirs, { name: "Someone else's", isPublic: true });

    const res = await request(app).get("/api/v1/routes").set("Authorization", `Bearer ${mine}`);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r: { trackPoints?: unknown }) => r.trackPoints === undefined)).toBe(
      true,
    );
  });
});

describe("PATCH / DELETE /api/v1/routes/:routeId", () => {
  it("lets the owner publish and unpublish", async () => {
    const app = createApp();
    const token = await signIn(app, "pub-owner");
    const created = await createRoute(app, token);

    const published = await request(app)
      .patch(`/api/v1/routes/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isPublic: true });
    expect(published.body.data.isPublic).toBe(true);

    const unpublished = await request(app)
      .patch(`/api/v1/routes/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isPublic: false });
    expect(unpublished.body.data.isPublic).toBe(false);
    expect((await request(app).get("/api/v1/routes/public")).body.data).toHaveLength(0);
  });

  it("403s a non-owner edit", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "pub-owner-2");
    const otherToken = await signIn(app, "pub-other-2");
    const created = await createRoute(app, ownerToken, { isPublic: true });

    const res = await request(app)
      .patch(`/api/v1/routes/${created.body.data.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Stolen" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/events/:eventId/route", () => {
  async function ownerWithEventAndRoute() {
    const app = createApp();
    const ownerToken = await signIn(app, "attach-owner");
    const event = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Saturday Ride", visibility: "public" });
    const route = await createRoute(app, ownerToken);
    return {
      app,
      ownerToken,
      eventId: event.body.data.id as string,
      routeId: route.body.data.id as number,
    };
  }

  it("attaches a route and returns it on the event, preview only", async () => {
    const { app, ownerToken, eventId, routeId } = await ownerWithEventAndRoute();

    const attach = await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId });
    expect(attach.status).toBe(200);

    const detail = await request(app)
      .get(`/api/v1/events/${eventId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.data.route.id).toBe(routeId);
    expect(detail.body.data.route.previewPoints).toHaveLength(4);
    expect(detail.body.data.route.trackPoints).toBeUndefined();
  });

  it("keeps the route on the response when the organizer edits the ride", async () => {
    const { app, ownerToken, eventId, routeId } = await ownerWithEventAndRoute();
    await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId });

    // EventDetailPage swaps a PATCH response straight into its state — dropping the route
    // here would make the map vanish on rename.
    const patched = await request(app)
      .patch(`/api/v1/events/${eventId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Renamed Ride" });
    expect(patched.body.data.route.id).toBe(routeId);
  });

  it("replaces the previous route rather than stacking a second one", async () => {
    const { app, ownerToken, eventId, routeId } = await ownerWithEventAndRoute();
    const second = await createRoute(app, ownerToken, { name: "Different way home" });

    await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId });
    await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: second.body.data.id });

    const detail = await request(app)
      .get(`/api/v1/events/${eventId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.data.route.id).toBe(second.body.data.id);
  });

  it("lets an organizer copy the track from someone else's published ride", async () => {
    const app = createApp();
    const strangerToken = await signIn(app, "copy-source-owner");
    const source = await createRoute(app, strangerToken, { isPublic: true });

    const ownerToken = await signIn(app, "copy-target-owner");
    const event = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Same route, new Saturday" });

    // Copying is an attach, not a duplicate: one row, and a fix to the line reaches everyone.
    const res = await request(app)
      .post(`/api/v1/events/${event.body.data.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: source.body.data.id });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(source.body.data.id);
  });

  it("refuses a route the organizer cannot even read", async () => {
    const app = createApp();
    const strangerToken = await signIn(app, "private-route-owner");
    const secret = await createRoute(app, strangerToken); // never published

    const ownerToken = await signIn(app, "attach-denied-owner");
    const event = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Nice try" });

    const res = await request(app)
      .post(`/api/v1/events/${event.body.data.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: secret.body.data.id });
    expect(res.status).toBe(404);
  });

  it("403s a non-owner attaching to someone else's ride", async () => {
    const { app, eventId, routeId } = await ownerWithEventAndRoute();
    const otherToken = await signIn(app, "attach-other");

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ routeId });
    expect(res.status).toBe(403);
  });

  it("detaches", async () => {
    const { app, ownerToken, eventId, routeId } = await ownerWithEventAndRoute();
    await request(app)
      .post(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId });

    const res = await request(app)
      .delete(`/api/v1/events/${eventId}/route`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);

    const detail = await request(app)
      .get(`/api/v1/events/${eventId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.data.route).toBeNull();
  });
});

describe("who may see an event's route", () => {
  async function privateRideWithRoute() {
    const app = createApp();
    const ownerToken = await signIn(app, "route-vis-owner");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Closed Ride", visibility: "private", requiresApproval: true });
    await request(app)
      .patch(`/api/v1/events/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "published" });
    const route = await createRoute(app, ownerToken);
    await request(app)
      .post(`/api/v1/events/${created.body.data.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: route.body.data.id });
    return { app, ownerToken, event: created.body.data };
  }

  it("hides it from a rider still waiting for approval", async () => {
    const { app, ownerToken, event } = await privateRideWithRoute();
    const riderToken = await signIn(app, "route-vis-rider");
    await request(app)
      .post("/api/v1/events/join")
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ eventCode: event.code });

    const pending = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(pending.body.data.viewerTier).toBe("pending");
    expect(pending.body.data.route).toBeNull();

    const list = await request(app)
      .get(`/api/v1/events/${event.id}/participants`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/v1/events/${event.id}/participants/${list.body.data[0].id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const approved = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(approved.body.data.route).not.toBeNull();
  });

  it("hides it from a public browser when show_route is off", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "route-vis-owner-2");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Open Ride", visibility: "public", showRoute: false });
    const route = await createRoute(app, ownerToken);
    await request(app)
      .post(`/api/v1/events/${created.body.data.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: route.body.data.id });

    const asGuest = await request(app).get(`/api/v1/events/${created.body.data.id}`);
    expect(asGuest.body.data.route).toBeNull();

    const asOwner = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(asOwner.body.data.route).not.toBeNull();
  });

  it("shows a public ride's track to a guest with no account", async () => {
    const app = createApp();
    const ownerToken = await signIn(app, "route-vis-owner-3");
    const created = await request(app)
      .post("/api/v1/events")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Open Ride", visibility: "public" });
    const route = await createRoute(app, ownerToken);
    await request(app)
      .post(`/api/v1/events/${created.body.data.id}/route`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ routeId: route.body.data.id });

    // The app's front door: browsing old rides and looking at their maps, no account needed.
    const res = await request(app).get(`/api/v1/events/${created.body.data.id}`);
    expect(res.body.data.route.previewPoints).toHaveLength(4);
  });
});
