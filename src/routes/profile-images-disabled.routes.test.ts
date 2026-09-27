// HTTP-level cover for the gallery DISABLED (env.PROFILE_IMAGES_DIR === null), through the real
// app — the actual regression this guards against was a production outage from
// config/env.ts's resolveProfileImagesDir calling process.exit(1) in exactly this situation.
// A separate file from profile-images.routes.test.ts so each gets its own fresh app/module
// instance; this one mutates the shared `env` object before createApp() runs.
//
// The authenticated PUT /users/me/avatar { galleryKey } path is NOT exercised here: like every
// other authenticated success path in this repo's route tests (see user-image.routes.test.ts's
// header comment), it needs a real database this test suite has no stub for. That path's
// "reject cleanly, never throw" guarantee is covered at the unit level instead — see
// config/profile-images-disabled.test.ts's isProfileImageKey case, which is exactly what
// services/user-image.service.ts's setGalleryImage relies on to answer a clean 400.

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { env } from "../config/env.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env.PROFILE_IMAGES_DIR = null;
  app = createApp();
});

describe("GET /api/v1/profile-images, gallery disabled", () => {
  it("still answers 200 with an empty catalog, not an error", async () => {
    const res = await request(app).get("/api/v1/profile-images");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("the gallery static mount, gallery disabled", () => {
  it("404s instead of crashing the app — nothing was mounted to serve it from", async () => {
    const res = await request(app).get("/public-app-images/trail-01.webp");
    expect(res.status).toBe(404);
  });
});

describe("everything unrelated still works", () => {
  it("still answers /health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("still serves the shipped presets (a different, unaffected feature)", async () => {
    const res = await request(app).get("/api/v1/users/image-presets");
    expect(res.status).toBe(200);
  });

  it("auth still gates the usual routes", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(401);
  });
});
