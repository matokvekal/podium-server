// HTTP-level check on the public ride-image catalog, through the real app. Same "stop at the
// first thing that needs the database" boundary as adminAnalytics.routes.test.ts / profile-
// images.routes.test.ts — this repo has no test DB, so the 200 path (actual rows) is exercised
// live against the real database instead, not here.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const app = createApp();

describe("GET /api/v1/ride-images", () => {
  it("401s an unauthenticated request — any signed-in rider may read this, but a stranger may not", async () => {
    const res = await request(app).get("/api/v1/ride-images");
    expect(res.status).toBe(401);
  });

  it("401s a forged token before any query runs", async () => {
    const res = await request(app)
      .get("/api/v1/ride-images")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("the route exists (not a 404 swallowed by another handler)", async () => {
    const res = await request(app).get("/api/v1/ride-images");
    expect(res.status).not.toBe(404);
  });
});
