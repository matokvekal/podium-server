// HTTP-level check on the System Admin's ride-image management API, through the real app.
// Confirms the SAME gate as adminAnalytics.routes.test.ts is actually wired onto every one of
// these routes — requireAuth then requireAdminAnalytics, reused rather than reimplemented (see
// routes/adminRideImages.routes.ts's header). The 200/201/403-as-a-real-non-admin paths need the
// database (selectUserEmails) and are covered live instead — see adminAnalytics.auth.test.ts for
// that middleware tested in isolation, and this file's own header note.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const app = createApp();

describe("the System Admin ride-image API requires the same gate on every method", () => {
  it.each([
    ["GET", "/api/v1/admin/ride-images"],
    ["POST", "/api/v1/admin/ride-images"],
    ["POST", "/api/v1/admin/ride-images/sukkot-01/replace"],
    ["PATCH", "/api/v1/admin/ride-images/sukkot-01"],
    ["DELETE", "/api/v1/admin/ride-images/sukkot-01"],
  ] as const)("%s %s 401s with no token", async (method, path) => {
    const res = await request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](
      path,
    );
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });

  it.each([
    ["GET", "/api/v1/admin/ride-images"],
    ["POST", "/api/v1/admin/ride-images"],
    ["POST", "/api/v1/admin/ride-images/sukkot-01/replace"],
    ["PATCH", "/api/v1/admin/ride-images/sukkot-01"],
    ["DELETE", "/api/v1/admin/ride-images/sukkot-01"],
  ] as const)("%s %s 401s a forged token before any query runs", async (method, path) => {
    const res = await request(app)
      [method.toLowerCase() as "get" | "post" | "patch" | "delete"](path)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});
