// HTTP-level: every track-video method requires a login, and the raw video body is accepted by
// the transport (express.raw on /api/v1/routes) only up to the 3 MB ceiling.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ROUTE_VIDEO_MAX_BYTES } from "../config/route-videos.js";

const app = createApp();

describe("track video endpoints", () => {
  it.each(["get", "put", "delete"] as const)(
    "%s /routes/:id/video 401s with no token",
    async (m) => {
      const res = await request(app)[m]("/api/v1/routes/1/video");
      expect(res.status).toBe(401);
    },
  );

  it("the ride's track-video info 401s with no token", async () => {
    const res = await request(app).get(
      "/api/v1/events/00000000-0000-0000-0000-000000000000/route/video",
    );
    expect(res.status).toBe(401);
  });

  it("an over-limit body is refused by the transport", async () => {
    const res = await request(app)
      .put("/api/v1/routes/1/video")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(ROUTE_VIDEO_MAX_BYTES + 1));
    expect(res.status).toBe(413);
  });
});
