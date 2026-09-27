// HTTP-level cover for the profile-image gallery: the catalog endpoint and the static mount,
// through the real app. See src/config/__fixtures__/profile-images for what this test env's
// PROFILE_IMAGES_DIR (vitest.config.ts) actually contains.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const app = createApp();

describe("GET /api/v1/profile-images", () => {
  it("is public — no token required", async () => {
    const res = await request(app).get("/api/v1/profile-images");
    expect(res.status).toBe(200);
  });

  it("lists the fixture gallery's selectable images only", async () => {
    const res = await request(app).get("/api/v1/profile-images");
    expect(res.body.data).toEqual([
      { key: "trail-01.webp", url: expect.stringContaining("/public-app-images/trail-01.webp") },
      { key: "trail-02.png", url: expect.stringContaining("/public-app-images/trail-02.png") },
    ]);
  });
});

describe("the gallery folder is actually served", () => {
  it("returns a file from PROFILE_IMAGES_DIR", async () => {
    const res = await request(app).get("/public-app-images/trail-01.webp");

    expect(res.status).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("404s for a file that was never in the gallery", async () => {
    const res = await request(app).get("/public-app-images/does-not-exist.webp");
    expect(res.status).toBe(404);
  });

  it("does not serve anything outside the gallery directory", async () => {
    const res = await request(app).get("/public-app-images/../../package.json");
    expect(res.status).toBe(404);
  });

  it("does not serve the extension-excluded fixture file directly by surprise", async () => {
    // express.static has no notion of the catalog's extension allow-list — this just documents
    // that a non-image file dropped in the folder is still reachable by direct URL, which is
    // why the SELECTION side (isProfileImageKey) is the real security boundary, not serving.
    const res = await request(app).get("/public-app-images/ignored-notes.txt");
    expect(res.status).toBe(200);
  });
});

describe("existing routes are unaffected", () => {
  it("still answers /health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("still serves the shipped presets", async () => {
    const res = await request(app).get("/api/v1/users/image-presets");
    expect(res.status).toBe(200);
  });
});
