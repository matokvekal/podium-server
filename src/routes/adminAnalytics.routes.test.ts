// HTTP-level check on the admin dashboard endpoint, through the real app (route table +
// requireAuth + error handler). Stops at the first thing that needs the database — the
// authenticated 403 / 200 paths reach selectUserEmails() -> Postgres, and this repo has no
// test DB, so those are covered in adminAnalytics.auth.test.ts (the middleware in isolation).

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const app = createApp();

describe("GET /api/v1/admin/analytics", () => {
  it("401s an unauthenticated request — the URL is not the gate", async () => {
    const res = await request(app).get("/api/v1/admin/analytics");
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("data");
  });

  it("401s a forged token before any query runs", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics?range=7")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("the route exists (not a 404 swallowed by another handler)", async () => {
    const res = await request(app).get("/api/v1/admin/analytics");
    expect(res.status).not.toBe(404);
  });
});
