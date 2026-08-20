// Wave 4: the ride profile fields the create form always collected, the real organizer, the
// public browse filters, bulk import, and offline replay de-duplication.
//
// The browse filters matter more than they look: every one of them used to run in the client's
// memory over whatever the first 20 rows happened to be, so a "Finished" pill could render
// empty while finished rides sat at row 21.

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

function createEvent(app: App, token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/v1/events")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "A ride", visibility: "public", ...body });
}

async function publish(app: App, token: string, eventId: string, upTo = "published") {
  const chain = ["published", "registration_open", "ready", "live", "finished"];
  for (const status of chain.slice(0, chain.indexOf(upTo) + 1)) {
    await request(app)
      .patch(`/api/v1/events/${eventId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status });
  }
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("ride profile fields", () => {
  it("stores activity type, level and organizing club on create", async () => {
    const app = createApp();
    const token = await signIn(app, "profile-owner");

    const res = await createEvent(app, token, {
      activityType: "gravel",
      level: "intermediate",
      organizerGroup: "Galilee Cycling Club",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.activityType).toBe("gravel");
    expect(res.body.data.level).toBe("intermediate");
    expect(res.body.data.organizerGroup).toBe("Galilee Cycling Club");
  });

  it("puts them on the list summary too, so cards need no second call", async () => {
    const app = createApp();
    const token = await signIn(app, "profile-owner-2");
    const created = await createEvent(app, token, { activityType: "mtb", level: "elite" });
    await publish(app, token, created.body.data.id);

    const list = await request(app).get("/api/v1/events/public");
    expect(list.body.data[0].activityType).toBe("mtb");
    expect(list.body.data[0].level).toBe("elite");
  });

  it("rejects an activity type that is not one of ours", async () => {
    const app = createApp();
    const token = await signIn(app, "profile-owner-3");
    const res = await createEvent(app, token, { activityType: "kayaking" });
    expect(res.status).toBe(400);
  });
});

describe("the real organizer", () => {
  it("names them on the event detail instead of leaving the client to invent one", async () => {
    const app = createApp();
    const token = await signIn(app, "org-owner", "Dani", "Cohen");
    const created = await createEvent(app, token, {});

    const res = await request(app)
      .get(`/api/v1/events/${created.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);

    // Every ride used to display a fake name derived from the event id.
    expect(res.body.data.owner).toMatchObject({ name: "Dani Cohen" });
  });
});

describe("GET /api/v1/events/public — filters and paging", () => {
  async function library(app: App) {
    const token = await signIn(app, "browse-owner");

    const gravel = await createEvent(app, token, {
      name: "Galilee Gravel",
      location: "Galilee",
      activityType: "gravel",
      level: "beginner",
      startsAt: "2026-09-01T05:00:00.000Z",
    });
    await publish(app, token, gravel.body.data.id);

    const road = await createEvent(app, token, {
      name: "Ashkelon Road",
      location: "Ashkelon",
      activityType: "road",
      level: "elite",
      startsAt: "2026-10-01T05:00:00.000Z",
    });
    await publish(app, token, road.body.data.id);

    const done = await createEvent(app, token, {
      name: "Last Saturday",
      location: "Galilee",
      activityType: "road",
      startsAt: "2026-07-01T05:00:00.000Z",
    });
    await publish(app, token, done.body.data.id, "finished");

    return { token, ids: { gravel: gravel.body.data.id, road: road.body.data.id } };
  }

  it("searches name and place", async () => {
    const app = createApp();
    await library(app);

    const byName = await request(app).get("/api/v1/events/public?q=ashkelon");
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].name).toBe("Ashkelon Road");

    // Two rides are in the Galilee — one upcoming, one finished.
    const byPlace = await request(app).get("/api/v1/events/public?q=galilee");
    expect(byPlace.body.data).toHaveLength(2);
  });

  it("filters by activity type and level", async () => {
    const app = createApp();
    await library(app);

    const gravel = await request(app).get("/api/v1/events/public?activityType=gravel");
    expect(gravel.body.data).toHaveLength(1);

    const elite = await request(app).get("/api/v1/events/public?level=elite");
    expect(elite.body.data).toHaveLength(1);
    expect(elite.body.data[0].name).toBe("Ashkelon Road");
  });

  it("splits Live / Upcoming / Finished the way the pills do", async () => {
    const app = createApp();
    await library(app);

    const upcoming = await request(app).get("/api/v1/events/public?bucket=upcoming");
    expect(upcoming.body.data.map((e: { name: string }) => e.name)).toEqual([
      "Galilee Gravel",
      "Ashkelon Road",
    ]);

    const finished = await request(app).get("/api/v1/events/public?bucket=finished");
    expect(finished.body.data).toHaveLength(1);
    expect(finished.body.data[0].name).toBe("Last Saturday");

    const live = await request(app).get("/api/v1/events/public?bucket=live");
    expect(live.body.data).toHaveLength(0);
  });

  it("counts a ride whose end time passed as finished, whatever its status says", async () => {
    const app = createApp();
    const token = await signIn(app, "stale-owner");
    const created = await createEvent(app, token, {
      name: "Nobody pressed stop",
      startsAt: "2026-07-01T05:00:00.000Z",
      endsAt: "2026-07-01T09:00:00.000Z",
    });
    await publish(app, token, created.body.data.id);

    // Status is still "published" — nothing flips it automatically.
    const finished = await request(app).get("/api/v1/events/public?bucket=finished");
    expect(finished.body.data).toHaveLength(1);

    const upcoming = await request(app).get("/api/v1/events/public?bucket=upcoming");
    expect(upcoming.body.data).toHaveLength(0);
  });

  it("orders upcoming soonest-first and finished most-recent-first", async () => {
    const app = createApp();
    const token = await signIn(app, "sort-owner");
    for (const [name, startsAt] of [
      ["Later", "2026-12-01T05:00:00.000Z"],
      ["Sooner", "2026-09-01T05:00:00.000Z"],
    ] as const) {
      const created = await createEvent(app, token, { name, startsAt });
      await publish(app, token, created.body.data.id);
    }

    const upcoming = await request(app).get("/api/v1/events/public?bucket=upcoming");
    expect(upcoming.body.data[0].name).toBe("Sooner");

    // The old unconditional "starts_at ASC" put the oldest ride in the database on top.
    const explicit = await request(app).get("/api/v1/events/public?sort=latest");
    expect(explicit.body.data[0].name).toBe("Later");
  });

  it("reports a total, so a client can page instead of guessing", async () => {
    const app = createApp();
    await library(app);

    const page = await request(app).get("/api/v1/events/public?limit=1&offset=0");
    expect(page.body.data).toHaveLength(1);
    expect(page.body.total).toBe(3);
    expect(page.body.limit).toBe(1);
  });
});

describe("POST …/participants/import", () => {
  async function ownedEvent(app: App) {
    const token = await signIn(app, "import-owner");
    const created = await createEvent(app, token, {});
    return { token, eventId: created.body.data.id as string };
  }

  it("imports a whole spreadsheet in one request", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/participants/import`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        participants: [
          { name: "Ada Lovelace", phone: "+972500000001", team: "Club A", countryCode: "il" },
          { name: "Bea Smith", email: "bea@example.com" },
          { name: "Cai Jones", bib: "17" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(3);
    // Organizer-added riders are approved immediately, same as a single manual add.
    expect(res.body.data[0].registrationStatus).toBe("approved");
    expect(res.body.data[0].team).toBe("Club A");
    // Country codes are uppercased on the way in, so "il" and "IL" cannot both be stored.
    expect(res.body.data[0].countryCode).toBe("IL");

    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(3);
  });

  it("imports nothing at all when one row is invalid", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/participants/import`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        participants: [{ name: "Ada Lovelace" }, { name: "" }, { name: "Cai Jones" }],
      });

    expect(res.status).toBe(400);
    // A half-imported start list with no way to tell which half is the thing to avoid.
    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(0);
  });

  it("403s a non-owner", async () => {
    const app = createApp();
    const { eventId } = await ownedEvent(app);
    const otherToken = await signIn(app, "import-other");

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/participants/import`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ participants: [{ name: "Gatecrasher" }] });
    expect(res.status).toBe(403);
  });
});

describe("offline replay de-duplication", () => {
  const ACTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  async function ownedEvent(app: App) {
    const token = await signIn(app, "dedup-owner");
    const created = await createEvent(app, token, {});
    return { token, eventId: created.body.data.id as string };
  }

  it("applies a replayed action once, and answers the repeat with the original result", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);
    const body = { name: "Ada Lovelace" };

    const first = await request(app)
      .post(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Action-Id", ACTION_ID)
      .send(body);
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Action-Id", ACTION_ID)
      .send(body);

    // The client treats 409 as success and reads body.data as the action's result.
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("DUPLICATE_CLIENT_ACTION");
    expect(replay.body.data.id).toBe(first.body.data.id);

    // And crucially: one rider on the list, not two.
    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(1);
  });

  it("adds twice when the two requests carry different action ids", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    for (const id of [ACTION_ID, "3f2504e0-4f89-41d3-9a0c-0305e82c3302"]) {
      await request(app)
        .post(`/api/v1/events/${eventId}/participants`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Client-Action-Id", id)
        .send({ name: "Ada Lovelace" });
    }

    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(2);
  });

  it("lets a failed action be retried with the same id", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    const failed = await request(app)
      .post(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Action-Id", ACTION_ID)
      .send({ name: "" });
    expect(failed.status).toBe(400);

    // Holding the claim would have made a transient failure permanent for that id.
    const retry = await request(app)
      .post(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Action-Id", ACTION_ID)
      .send({ name: "Ada Lovelace" });
    expect(retry.status).toBe(201);
  });

  it("ignores a malformed id rather than failing the rider's action", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    const res = await request(app)
      .post(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Action-Id", "not-a-uuid")
      .send({ name: "Ada Lovelace" });
    expect(res.status).toBe(201);
  });

  it("behaves exactly as before when no header is sent", async () => {
    const app = createApp();
    const { token, eventId } = await ownedEvent(app);

    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/api/v1/events/${eventId}/participants`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: `Rider ${i}` });
    }

    const list = await request(app)
      .get(`/api/v1/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data).toHaveLength(2);
  });
});
