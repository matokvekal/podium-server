// HTTP-level cover for the Route Builder proxy — through the real app, JWT check, schema and
// limiter. Only the routing provider is replaced; no database is touched by these routes, and
// db/pool.js is mocked to throw so that stays true.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutingProvider } from "../lib/routing/provider.js";

const routing = vi.hoisted(() => ({ provider: null as RoutingProvider | null }));

vi.mock("../db/pool.js", () => ({
  pool: {
    query: () => {
      throw new Error("route-builder must not touch the database");
    },
  },
}));
vi.mock("../lib/routing/index.js", () => ({ getRoutingProvider: () => routing.provider }));

const { createApp } = await import("../app.js");
const { signAccessToken } = await import("../lib/jwt.js");
const { ApiError } = await import("../lib/api-error.js");
const { ROUTE_SEGMENTS_PER_MINUTE } = await import("./routeBuilder.routes.js");

const app = createApp();
let userSeq = 1000;
async function bearer(): Promise<string> {
  const t = await signAccessToken({ sub: String(userSeq++), role: "RIDER", sid: "1" } as never);
  return `Bearer ${t}`;
}

const PEDAYA = { lat: 31.85, lng: 34.95 };
const NACHSHON = { lat: 31.83, lng: 34.97 };
const SEGMENT = { points: [[31.85, 34.95, 170], [31.83, 34.97, 180]], distanceM: 2900 };

beforeEach(() => {
  routing.provider = { calculateSegment: vi.fn().mockResolvedValue(SEGMENT) };
});

describe("GET /api/v1/route-builder/config", () => {
  it("says whether routing is on", async () => {
    expect((await request(app).get("/api/v1/route-builder/config")).body).toEqual({
      data: { routingEnabled: true },
    });
    routing.provider = null;
    expect((await request(app).get("/api/v1/route-builder/config")).body).toEqual({
      data: { routingEnabled: false },
    });
  });
});

describe("POST /api/v1/route-builder/segment", () => {
  const url = "/api/v1/route-builder/segment";

  it("requires sign-in", async () => {
    const res = await request(app).post(url).send({ from: PEDAYA, to: NACHSHON, profile: "road" });
    expect(res.status).toBe(401);
  });

  it("returns the routed segment for each profile", async () => {
    for (const profile of ["road", "mtb"] as const) {
      const res = await request(app)
        .post(url)
        .set("Authorization", await bearer())
        .send({ from: PEDAYA, to: NACHSHON, profile });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: SEGMENT });
      expect(routing.provider?.calculateSegment).toHaveBeenLastCalledWith(PEDAYA, NACHSHON, profile);
    }
  });

  it("rejects bad coordinates and unknown profiles", async () => {
    const auth = await bearer();
    for (const body of [
      { from: { lat: 91, lng: 0 }, to: NACHSHON, profile: "road" },
      { from: PEDAYA, to: { lat: "x", lng: 1 }, profile: "road" },
      { from: PEDAYA, to: NACHSHON, profile: "car" },
      { from: PEDAYA, profile: "road" },
    ]) {
      const res = await request(app).post(url).set("Authorization", auth).send(body);
      expect(res.status).toBe(400);
    }
    expect(routing.provider?.calculateSegment).not.toHaveBeenCalled();
  });

  it("refuses points too far apart to route in one step", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", await bearer())
      .send({ from: PEDAYA, to: { lat: 29.55, lng: 34.95 }, profile: "road" }); // ~255 km
    expect(res.status).toBe(400);
    expect(routing.provider?.calculateSegment).not.toHaveBeenCalled();
  });

  it("passes no-route through as a 422 and an outage as a 503", async () => {
    routing.provider = {
      calculateSegment: vi.fn().mockRejectedValue(new ApiError(422, "No bike route between these points")),
    };
    const noRoute = await request(app)
      .post(url)
      .set("Authorization", await bearer())
      .send({ from: PEDAYA, to: NACHSHON, profile: "mtb" });
    expect(noRoute.status).toBe(422);
    expect(noRoute.body.message).toBe("No bike route between these points");

    routing.provider = null;
    const off = await request(app)
      .post(url)
      .set("Authorization", await bearer())
      .send({ from: PEDAYA, to: NACHSHON, profile: "road" });
    expect(off.status).toBe(503);
  });

  it("rate-limits per rider", async () => {
    const auth = await bearer();
    const body = { from: PEDAYA, to: NACHSHON, profile: "road" };
    for (let i = 0; i < ROUTE_SEGMENTS_PER_MINUTE; i++) {
      expect((await request(app).post(url).set("Authorization", auth).send(body)).status).toBe(200);
    }
    expect((await request(app).post(url).set("Authorization", auth).send(body)).status).toBe(429);
    // A different rider is not affected.
    expect((await request(app).post(url).set("Authorization", await bearer()).send(body)).status).toBe(
      200,
    );
  });
});
