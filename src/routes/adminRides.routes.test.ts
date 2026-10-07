// HTTP-level check that the per-ride rider-cap API carries the same admin gate as
// adminRideImages.routes.test.ts. The 200 / real-non-admin 403 paths need the database
// (selectUserEmails) and are covered live, as for ride-images.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { setRideMaxParticipantsSchema } from "../schemas/adminRides.schemas.js";

const app = createApp();
const EVENT_ID = "00000000-0000-4000-8000-000000000001";

describe("the System Admin rides API requires the admin gate on every method", () => {
  it.each([
    ["GET", "/api/v1/admin/rides"],
    ["PATCH", `/api/v1/admin/rides/${EVENT_ID}`],
  ] as const)("%s %s 401s with no token", async (method, path) => {
    const res = await request(app)[method.toLowerCase() as "get" | "patch"](path);
    expect(res.status).toBe(401);
  });

  it.each([
    ["GET", "/api/v1/admin/rides"],
    ["PATCH", `/api/v1/admin/rides/${EVENT_ID}`],
  ] as const)("%s %s 401s a forged token", async (method, path) => {
    const res = await request(app)
      [method.toLowerCase() as "get" | "patch"](path)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("setRideMaxParticipantsSchema", () => {
  it.each([1, 300, 30_000, 100_000, null])("accepts %s", (value) => {
    expect(setRideMaxParticipantsSchema.parse({ maxParticipants: value })).toEqual({
      maxParticipants: value,
    });
  });

  it.each([0, -5, 2.5, 100_001, "300", undefined])("refuses %s", (value) => {
    expect(setRideMaxParticipantsSchema.safeParse({ maxParticipants: value }).success).toBe(false);
  });
});
