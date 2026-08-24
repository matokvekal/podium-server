// HTTP-level checks on the avatar/cover endpoints, through the real app: the route table,
// the body parsers wired in app.ts, requireAuth, and the error handler.
//
// These stop at the first thing that needs the database. Anything past requireAuth reaches
// buildActor() -> Postgres, and this repo has no test database or pool stub, so the
// authenticated success paths are covered by the manual run in the plan rather than here.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { AVATAR_PRESETS, COVER_PRESETS } from "../config/user-image-presets.js";
import { USER_IMAGE_RULES } from "../config/user-images.js";
import { png } from "../lib/__fixtures__/images.js";

const app = createApp();

describe("GET /api/v1/users/image-presets", () => {
  it("publishes the registry so a client cannot drift from what the server accepts", async () => {
    const res = await request(app).get("/api/v1/users/image-presets");

    expect(res.status).toBe(200);
    expect(res.body.data.avatars).toHaveLength(AVATAR_PRESETS.length);
    expect(res.body.data.covers).toHaveLength(COVER_PRESETS.length);
    expect(res.body.data.avatars[0]).toEqual({
      id: "avatar-mtb-01",
      url: expect.stringContaining("/assets/presets/avatars/avatar-mtb-01.svg"),
    });
  });

  it("is not swallowed by the /:userId/follow route", async () => {
    const res = await request(app).get("/api/v1/users/image-presets");
    expect(res.status).not.toBe(404);
  });
});

describe("the shipped preset art is actually served", () => {
  it("returns the SVG a preset id resolves to", async () => {
    const res = await request(app).get("/assets/presets/avatars/avatar-mtb-01.svg");

    expect(res.status).toBe(200);
    // supertest hands back a Buffer for image/svg+xml rather than decoding it as text.
    expect(res.body.toString("utf8")).toContain("<svg");
    // helmet's default same-origin CORP would stop the web client loading this from the API host.
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not serve anything outside the preset directory", async () => {
    const res = await request(app).get("/assets/presets/../../package.json");
    expect(res.status).toBe(404);
  });
});

describe("authentication", () => {
  it.each([
    ["put", "/api/v1/users/me/avatar"],
    ["delete", "/api/v1/users/me/avatar"],
    ["put", "/api/v1/users/me/cover"],
    ["delete", "/api/v1/users/me/cover"],
  ])("rejects an unauthenticated %s %s", async (method, path) => {
    const res = await request(app)[method as "put"](path);
    expect(res.status).toBe(401);
  });

  it("rejects an upload with a forged token before reading the body", async () => {
    const res = await request(app)
      .put("/api/v1/users/me/avatar")
      .set("Authorization", "Bearer not-a-real-token")
      .set("Content-Type", "image/png")
      .send(png(256, 256));

    expect(res.status).toBe(401);
  });
});

describe("there is no route through which one user could edit another", () => {
  it.each(["/api/v1/users/42/avatar", "/api/v1/users/42/cover"])("404s on %s", async (path) => {
    // The id lives in the access token and nowhere else, so this shape simply does not exist.
    const res = await request(app).put(path).set("Content-Type", "application/json").send({});
    expect(res.status).toBe(404);
  });
});

describe("the body-size guard runs at the transport, before authentication", () => {
  it("refuses an oversized avatar with a message naming the real limit", async () => {
    const oversized = Buffer.alloc(USER_IMAGE_RULES.avatar.maxBytes + 1024);

    const res = await request(app)
      .put("/api/v1/users/me/avatar")
      .set("Content-Type", "image/png")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.message).toContain("50 KB");
  });

  it("gives the cover its own, larger limit", async () => {
    // Over the avatar ceiling, under the cover one: this must NOT be refused at the transport.
    const between = Buffer.alloc(80 * 1024);

    const res = await request(app)
      .put("/api/v1/users/me/cover")
      .set("Content-Type", "image/jpeg")
      .send(between);

    expect(res.status).toBe(401); // rejected for having no token, not for its size
  });

  it("refuses an oversized cover with 413", async () => {
    const oversized = Buffer.alloc(USER_IMAGE_RULES.cover.maxBytes + 1024);

    const res = await request(app)
      .put("/api/v1/users/me/cover")
      .set("Content-Type", "image/jpeg")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.message).toContain("200 KB");
  });
});

describe("existing routes are unaffected", () => {
  it("still answers /health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("still requires a token for GET /api/v1/users/me", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(401);
  });

  it("keeps the 100kb JSON limit everywhere else", async () => {
    // The scoped express.raw mounts must not have widened the global parser.
    const res = await request(app)
      .patch("/api/v1/users/me")
      .set("Content-Type", "application/json")
      .send({ nickname: "x".repeat(200 * 1024) });

    expect(res.status).toBe(413);
  });
});
