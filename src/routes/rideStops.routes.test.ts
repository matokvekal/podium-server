// HTTP-level cover for ride stop points (sql/049) — called the way a client (or an attacker with
// curl) would: through the real app, the real JWT check, the real route table, schemas, service,
// policy.ts and the real rideStops.queries.ts SQL.
//
// Only the database is replaced: db/pool.js is an in-memory fake that understands exactly the
// statements this feature and the ride authorization issue, records every call, and THROWS on
// anything else — so this file can never reach a real database, and an unexpected query is a
// failure rather than a silent pass. selectEventById is stubbed so rides can be described as
// plain objects.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
interface Call {
  sql: string;
  params: readonly unknown[];
}

const db = vi.hoisted(() => ({
  calls: [] as { sql: string; params: readonly unknown[] }[],
  stops: [] as Record<string, unknown>[],
  nextId: 1,
  members: new Map<string, string>(), // `${eventId}:${userId}` -> role
  participants: new Map<string, string>(), // `${eventId}:${userId}` -> registration_status
  events: new Map<string, Record<string, unknown>>(),
  failStopsRead: null as null | { code: string },
}));

function run(sql: string, params: readonly unknown[] = []): Row[] {
  db.calls.push({ sql, params });
  const s = sql.replace(/\s+/g, " ").trim();
  const key = `${params[0]}:${params[1]}`;

  if (s.startsWith("SELECT role FROM users")) return [{ role: "RIDER" }];
  if (s.includes("FROM event_members WHERE event_id = $1 AND user_id = $2")) {
    const role = db.members.get(key);
    return role ? [{ role }] : [];
  }
  if (s.includes("FROM event_participants WHERE event_id = $1 AND user_id = $2")) {
    const status = db.participants.get(key);
    return status ? [{ registration_status: status }] : [];
  }
  if (s.includes("pg_advisory_xact_lock")) return [];
  if (s.includes("AS next_order FROM ride_stop_points WHERE ride_id = $1")) {
    const mine = db.stops.filter((r) => r.ride_id === params[0]);
    const next = mine.length ? Math.max(...mine.map((r) => Number(r.sort_order))) + 1 : 0;
    return [{ count: mine.length, next_order: next }];
  }
  if (s.startsWith("INSERT INTO ride_stop_points")) {
    const [ride_id, label, lat, lng, kind, sort_order, created_by] = params;
    const now = new Date("2026-09-24T06:00:00Z");
    const row = {
      id: String(db.nextId++),
      ride_id,
      label,
      lat,
      lng,
      kind,
      sort_order,
      created_by,
      created_at: now,
      updated_at: now,
    };
    db.stops.push(row);
    return [row];
  }
  if (s.startsWith("SELECT") && s.includes("FROM ride_stop_points WHERE ride_id = $1 ORDER BY")) {
    if (db.failStopsRead) throw Object.assign(new Error("db failure"), db.failStopsRead);
    return db.stops
      .filter((r) => r.ride_id === params[0])
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
  }
  if (s.startsWith("UPDATE ride_stop_points SET")) {
    const row = db.stops.find((r) => r.ride_id === params[0] && r.id === String(params[1]));
    if (!row) return [];
    const column: Record<string, string> = { sort_order: "sort_order" };
    for (const m of s.matchAll(/(\w+) = \$(\d+)/g)) {
      if (m[1] === "ride_id" || m[1] === "id") continue;
      row[column[m[1]] ?? m[1]] = params[Number(m[2]) - 1];
    }
    return [row];
  }
  if (s.startsWith("DELETE FROM ride_stop_points")) {
    const i = db.stops.findIndex((r) => r.ride_id === params[0] && r.id === String(params[1]));
    if (i < 0) return [];
    const [row] = db.stops.splice(i, 1);
    return [{ id: row.id }];
  }
  throw new Error(`fake db: unexpected SQL: ${s.slice(0, 120)}`);
}

vi.mock("../db/pool.js", () => ({
  query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
  queryOne: async (sql: string, params?: readonly unknown[]) => run(sql, params)[0] ?? null,
  execute: async (sql: string, params?: readonly unknown[]) => run(sql, params).length,
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
      queryOne: async (sql: string, params?: readonly unknown[]) => run(sql, params)[0] ?? null,
    }),
  pool: { on: () => undefined, end: async () => undefined },
  closePool: async () => undefined,
}));

vi.mock("../queries/event.queries.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectEventById: async (id: string) => db.events.get(id) ?? null,
}));

vi.mock("../authz/entitlements.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../authz/entitlements.js")>();
  return { ...original, resolveEntitlements: async () => original.ANONYMOUS_ENTITLEMENTS };
});

const { createApp } = await import("../app.js");
const { signAccessToken } = await import("../lib/jwt.js");

const app = createApp();

const PUBLIC_RIDE = "11111111-1111-4111-8111-111111111111";
const PRIVATE_RIDE = "22222222-2222-4222-8222-222222222222";
const FINISHED_RIDE = "33333333-3333-4333-8333-333333333333";
const OTHER_RIDE = "44444444-4444-4444-8444-444444444444";
const LIVE_RIDE = "55555555-5555-4555-8555-555555555555";
const MISSING_RIDE = "99999999-9999-4999-8999-999999999999";

const OWNER = 1;
const OPERATOR = 2;
const RIDER = 3;
const PENDING = 4;
const STRANGER = 5;

function ride(id: string, over: Row = {}): Row {
  return {
    id,
    ownerId: OWNER,
    status: "published",
    visibility: "public",
    showRoute: true,
    showEventInfo: true,
    showParticipants: true,
    showLiveLocations: true,
    showResults: true,
    showHistoryLocations: false,
    ...over,
  };
}

const tokens = new Map<number, string>();
async function auth(userId: number): Promise<string> {
  let t = tokens.get(userId);
  if (!t) {
    t = await signAccessToken({ sub: String(userId), role: "RIDER", sid: "1" } as never);
    tokens.set(userId, t);
  }
  return `Bearer ${t}`;
}

const stopsUrl = (rideId: string) => `/api/v1/events/${rideId}/stops`;
const stopUrl = (rideId: string, stopId: number | string) => `${stopsUrl(rideId)}/${stopId}`;

async function addAsOwner(rideId: string, label: string) {
  return request(app)
    .post(stopsUrl(rideId))
    .set("Authorization", await auth(OWNER))
    .send({ label, lat: 32.7, lng: 35.0 });
}

beforeEach(() => {
  db.calls = [];
  db.stops = [];
  db.nextId = 1;
  db.failStopsRead = null;
  db.members.clear();
  db.participants.clear();
  db.events.clear();
  for (const id of [PUBLIC_RIDE, OTHER_RIDE]) db.events.set(id, ride(id));
  db.events.set(PRIVATE_RIDE, ride(PRIVATE_RIDE, { visibility: "private" }));
  db.events.set(FINISHED_RIDE, ride(FINISHED_RIDE, { status: "finished" }));
  db.events.set(LIVE_RIDE, ride(LIVE_RIDE, { status: "live" }));
  for (const id of [PUBLIC_RIDE, PRIVATE_RIDE, FINISHED_RIDE, OTHER_RIDE, LIVE_RIDE]) {
    db.members.set(`${id}:${OPERATOR}`, "operator");
    db.participants.set(`${id}:${RIDER}`, "approved");
    db.participants.set(`${id}:${PENDING}`, "waiting_approval");
  }
});

// ---------------------------------------------------------------------------------------------

describe("ride creator — full lifecycle over HTTP", () => {
  it("adds, reads, renames, drags, deletes", async () => {
    const created = await addAsOwner(PUBLIC_RIDE, "קפה ג'ו");
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: 1, label: "קפה ג'ו", kind: "coffee" });

    const list = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(OWNER));
    expect(list.status).toBe(200);
    expect(list.body.data.canManage).toBe(true);
    expect(list.body.data.limits).toEqual({ maxStops: 5, maxLabelLength: 120 });
    expect(list.body.data.stops).toHaveLength(1);

    const renamed = await request(app)
      .patch(stopUrl(PUBLIC_RIDE, 1))
      .set("Authorization", await auth(OWNER))
      .send({ label: "Coffee Joe" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.label).toBe("Coffee Joe");

    const dragged = await request(app)
      .patch(stopUrl(PUBLIC_RIDE, 1))
      .set("Authorization", await auth(OWNER))
      .send({ lat: 32.71, lng: 35.02 });
    expect(dragged.status).toBe(200);
    expect(dragged.body.data).toMatchObject({ lat: 32.71, lng: 35.02, label: "Coffee Joe" });

    const deleted = await request(app).delete(stopUrl(PUBLIC_RIDE, 1)).set("Authorization", await auth(OWNER));
    expect(deleted.status).toBe(204);
    expect(db.stops).toHaveLength(0);
  });

  it("may still manage stops while the ride is live", async () => {
    expect((await addAsOwner(LIVE_RIDE, "Water")).status).toBe(201);
  });

  it("0, 1 and 5 stops read back in order; the 6th is refused with 409", async () => {
    const empty = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(empty.body.data.stops).toEqual([]);

    await addAsOwner(PUBLIC_RIDE, "one");
    const one = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(one.body.data.stops.map((s: Row) => s.label)).toEqual(["one"]);

    for (const label of ["two", "three", "four", "five"]) {
      expect((await addAsOwner(PUBLIC_RIDE, label)).status).toBe(201);
    }
    const five = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(five.body.data.stops.map((s: Row) => s.label)).toEqual(["one", "two", "three", "four", "five"]);
    expect(five.body.data.stops.map((s: Row) => s.sortOrder)).toEqual([0, 1, 2, 3, 4]);

    const sixth = await addAsOwner(PUBLIC_RIDE, "six");
    expect(sixth.status).toBe(409);
    expect(db.stops).toHaveLength(5);
  });
});

describe("everyone else is refused by the SERVER, not just a hidden button", () => {
  const writes = async (userId: number | null, rideId = PUBLIC_RIDE) => {
    db.stops.push({
      id: "50",
      ride_id: rideId,
      label: "existing",
      lat: 32,
      lng: 35,
      kind: "coffee",
      sort_order: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const h = userId === null ? {} : { Authorization: await auth(userId) };
    const add = await request(app).post(stopsUrl(rideId)).set(h).send({ label: "x", lat: 1, lng: 1 });
    const edit = await request(app).patch(stopUrl(rideId, 50)).set(h).send({ label: "hacked" });
    const drag = await request(app).patch(stopUrl(rideId, 50)).set(h).send({ lat: 1, lng: 1 });
    const del = await request(app).delete(stopUrl(rideId, 50)).set(h);
    return [add.status, edit.status, drag.status, del.status];
  };

  it("an approved rider can read but gets 403 on add / edit / drag / delete", async () => {
    const read = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(RIDER));
    expect(read.status).toBe(200);
    expect(read.body.data.canManage).toBe(false);
    expect(await writes(RIDER)).toEqual([403, 403, 403, 403]);
    expect(db.stops[0]).toMatchObject({ label: "existing", lat: 32 });
  });

  it("a co-organizer (operator) is refused — the rule is creator-only", async () => {
    const read = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(OPERATOR));
    expect(read.body.data.canManage).toBe(false);
    expect(await writes(OPERATOR)).toEqual([403, 403, 403, 403]);
  });

  it("a signed-in stranger on a public ride can read, cannot write", async () => {
    const read = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(STRANGER));
    expect(read.status).toBe(200);
    expect(await writes(STRANGER)).toEqual([403, 403, 403, 403]);
  });

  it("signed out: can read a public ride's stops, every write is 401", async () => {
    const read = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(read.status).toBe(200);
    expect(read.body.data.canManage).toBe(false);
    expect(await writes(null)).toEqual([401, 401, 401, 401]);
  });

  it("a forged token is anonymous on read and 401 on write", async () => {
    const read = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", "Bearer forged");
    expect(read.status).toBe(200);
    const add = await request(app)
      .post(stopsUrl(PUBLIC_RIDE))
      .set("Authorization", "Bearer forged")
      .send({ label: "x", lat: 1, lng: 1 });
    expect(add.status).toBe(401);
  });

  it("private ride: a stranger gets 404 (existence not leaked); the approved rider reads", async () => {
    const stranger = await request(app).get(stopsUrl(PRIVATE_RIDE)).set("Authorization", await auth(STRANGER));
    expect(stranger.status).toBe(404);
    const anon = await request(app).get(stopsUrl(PRIVATE_RIDE));
    expect(anon.status).toBe(404);
    const rider = await request(app).get(stopsUrl(PRIVATE_RIDE)).set("Authorization", await auth(RIDER));
    expect(rider.status).toBe(200);
  });

  it("a rider still waiting for approval sees no stops (same rule as the route)", async () => {
    await addAsOwner(PRIVATE_RIDE, "secret café");
    const pending = await request(app).get(stopsUrl(PRIVATE_RIDE)).set("Authorization", await auth(PENDING));
    expect(pending.status).toBe(200);
    expect(pending.body.data.stops).toEqual([]);
  });

  it("a ride whose route is hidden shows its stops to nobody outside it", async () => {
    db.events.set(PUBLIC_RIDE, ride(PUBLIC_RIDE, { showRoute: false }));
    await addAsOwner(PUBLIC_RIDE, "hidden");
    const res = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(STRANGER));
    expect(res.body.data.stops).toEqual([]);
  });

  it("the creator cannot change stops once the ride is finished", async () => {
    expect((await addAsOwner(FINISHED_RIDE, "late")).status).toBe(403);
  });
});

describe("validation", () => {
  const post = async (body: unknown, rideId = PUBLIC_RIDE) =>
    request(app).post(stopsUrl(rideId)).set("Authorization", await auth(OWNER)).send(body as object);

  it("rejects empty / whitespace / too-long labels", async () => {
    expect((await post({ label: "", lat: 1, lng: 1 })).status).toBe(400);
    expect((await post({ label: "   ", lat: 1, lng: 1 })).status).toBe(400);
    expect((await post({ label: "x".repeat(121), lat: 1, lng: 1 })).status).toBe(400);
    expect((await post({ label: "x".repeat(120), lat: 1, lng: 1 })).status).toBe(201);
    expect((await post({ lat: 1, lng: 1 })).status).toBe(400);
  });

  it("rejects bad coordinates", async () => {
    for (const [lat, lng] of [
      [91, 0],
      [-91, 0],
      [0, 181],
      [0, -181],
      ["32", 35],
      [null, 35],
    ]) {
      expect((await post({ label: "a", lat, lng })).status).toBe(400);
    }
    const halfDrag = await request(app)
      .patch(stopUrl(PUBLIC_RIDE, 1))
      .set("Authorization", await auth(OWNER))
      .send({ lat: 1 });
    expect(halfDrag.status).toBe(400);
    expect(db.stops).toHaveLength(0);
  });

  it("rejects an unknown kind", async () => {
    expect((await post({ label: "a", lat: 1, lng: 1, kind: "<img>" })).status).toBe(400);
  });

  it("nonexistent ride → 404; malformed ride id → 400", async () => {
    expect((await post({ label: "a", lat: 1, lng: 1 }, MISSING_RIDE)).status).toBe(404);
    expect((await request(app).get(stopsUrl(MISSING_RIDE))).status).toBe(404);
    const bad = await request(app).get("/api/v1/events/not-a-uuid/stops");
    expect(bad.status).toBe(400);
  });

  it("invalid stop id → 400; unknown stop id → 404", async () => {
    const h = { Authorization: await auth(OWNER) };
    expect((await request(app).patch(stopUrl(PUBLIC_RIDE, "abc")).set(h).send({ label: "x" })).status).toBe(400);
    expect((await request(app).patch(stopUrl(PUBLIC_RIDE, -1)).set(h).send({ label: "x" })).status).toBe(400);
    expect((await request(app).patch(stopUrl(PUBLIC_RIDE, 777)).set(h).send({ label: "x" })).status).toBe(404);
    expect((await request(app).delete(stopUrl(PUBLIC_RIDE, 777)).set(h)).status).toBe(404);
  });

  it("a stop that belongs to ANOTHER ride cannot be edited or deleted through this ride", async () => {
    await addAsOwner(OTHER_RIDE, "other ride's stop"); // id 1, on OTHER_RIDE
    const h = { Authorization: await auth(OWNER) };
    expect((await request(app).patch(stopUrl(PUBLIC_RIDE, 1)).set(h).send({ label: "moved" })).status).toBe(404);
    expect((await request(app).delete(stopUrl(PUBLIC_RIDE, 1)).set(h)).status).toBe(404);
    expect(db.stops[0]).toMatchObject({ ride_id: OTHER_RIDE, label: "other ride's stop" });
  });

  it("fields the client does not own are ignored (ride_id, created_by, id)", async () => {
    const res = await post({ label: "a", lat: 1, lng: 1, ride_id: OTHER_RIDE, created_by: 99, id: 500 });
    expect(res.status).toBe(201);
    expect(db.stops[0]).toMatchObject({ ride_id: PUBLIC_RIDE, created_by: OWNER, id: "1" });
  });
});

describe("labels are plain text and every statement is parameterized", () => {
  const nasty = [
    `<img src=x onerror=alert(1)>`,
    `<script>alert("x")</script>`,
    `'); DROP TABLE ride_stop_points; --`,
    `קפה "הבית" — עין הוד`,
    `Coffee & Cake @ km 42!?`,
    `☕🚴‍♂️ עצירה 🥐`,
  ];

  it("stores and returns each label byte-for-byte, and never puts it into SQL text", async () => {
    for (const label of nasty.slice(0, 5)) {
      const res = await addAsOwner(PUBLIC_RIDE, label);
      expect(res.status).toBe(201);
      expect(res.body.data.label).toBe(label);
    }
    // Reset: the cap is 5 — delete and continue with the 6th.
    const extra = nasty.slice(5);
    db.stops.splice(0, 1);
    for (const label of extra) expect((await addAsOwner(PUBLIC_RIDE, label)).status).toBe(201);

    const read = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(read.headers["content-type"]).toMatch(/application\/json/);
    for (const label of nasty.slice(1)) {
      expect(read.body.data.stops.map((s: Row) => s.label)).toContain(label);
    }

    const stopCalls: Call[] = db.calls.filter((c) => c.sql.includes("ride_stop_points"));
    expect(stopCalls.length).toBeGreaterThan(0);
    for (const call of stopCalls) {
      for (const label of nasty) expect(call.sql).not.toContain(label);
      expect(call.sql).not.toContain(PUBLIC_RIDE);
    }
  });

  it("the dynamic UPDATE only ever names fixed columns; values stay in params", async () => {
    await addAsOwner(PUBLIC_RIDE, "a");
    db.calls = [];
    await request(app)
      .patch(stopUrl(PUBLIC_RIDE, 1))
      .set("Authorization", await auth(OWNER))
      .send({ label: "b", lat: 1, lng: 2, kind: "water", sortOrder: 3, "label = 'x'": "y" });
    const update = db.calls.find((c) => c.sql.startsWith("UPDATE ride_stop_points"));
    expect(update?.sql.replace(/\s+/g, " ")).toMatch(
      /^UPDATE ride_stop_points SET label = \$3, lat = \$4, lng = \$5, kind = \$6, sort_order = \$7, updated_at = NOW\(\) WHERE ride_id = \$1 AND id = \$2 RETURNING/,
    );
    expect(update?.params).toEqual([PUBLIC_RIDE, 1, "b", 1, 2, "water", 3]);
  });
});

describe("fail-safe", () => {
  it("before sql/049 (42P01) the read answers 'no stops' with no editor — not an error", async () => {
    db.failStopsRead = { code: "42P01" };
    const res = await request(app).get(stopsUrl(PUBLIC_RIDE)).set("Authorization", await auth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stops: [], canManage: false });
  });

  it("any other stop-table failure is a 500 on THIS endpoint only", async () => {
    db.failStopsRead = { code: "57P01" };
    const res = await request(app).get(stopsUrl(PUBLIC_RIDE));
    expect(res.status).toBe(500);
  });
});
