// ⚠ TEMPORARY — these tests cover the developer sign-in and should be DELETED with it.
// See README.md > Developer sign-in.
//
// The point of most of these is not that the shortcut works, but that it is genuinely
// unreachable when it is meant to be off. A passwordless login that only *looks* disabled
// is worse than none at all.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/lib/google-auth.js", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  InvalidGoogleTokenError: class InvalidGoogleTokenError extends Error {},
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function freshApp() {
  vi.resetModules();
  const { createApp } = await import("../src/app.js");
  return createApp();
}

describe("developer sign-in (temporary)", () => {
  it("issues a usable session for a fake commissaire", async () => {
    const app = await freshApp();

    const res = await request(app).post("/api/v1/auth/dev-login").send({});
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("COMMISSAIRE");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    // The profile is filled in for it, so the client lands in the app, not profile setup.
    expect(res.body.requiresProfile).toBe(false);

    // The token is a real one — it has to satisfy requireAuth on an ordinary route.
    const me = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("COMMISSAIRE");
  });

  it("honours the requested role", async () => {
    const app = await freshApp();

    const res = await request(app).post("/api/v1/auth/dev-login").send({ role: "RIDER" });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("RIDER");
  });

  it("reuses one account per key, and keeps different keys apart", async () => {
    const app = await freshApp();

    const first = await request(app).post("/api/v1/auth/dev-login").send({ key: "alice" });
    const again = await request(app).post("/api/v1/auth/dev-login").send({ key: "alice" });
    const other = await request(app).post("/api/v1/auth/dev-login").send({ key: "bob" });

    expect(again.body.user.id).toBe(first.body.user.id);
    expect(other.body.user.id).not.toBe(first.body.user.id);
  });

  it("rejects a key that is not a plain slug", async () => {
    const app = await freshApp();

    const res = await request(app).post("/api/v1/auth/dev-login").send({ key: "../../etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("advertises itself through /auth/config", async () => {
    const app = await freshApp();

    const res = await request(app).get("/api/v1/auth/config");
    expect(res.body.devLogin).toBe(true);
  });

  it("is a 404 when DEV_LOGIN_ENABLED is false, and says so in /auth/config", async () => {
    vi.stubEnv("DEV_LOGIN_ENABLED", "false");
    const app = await freshApp();

    const res = await request(app).post("/api/v1/auth/dev-login").send({});
    expect(res.status).toBe(404);

    const cfg = await request(app).get("/api/v1/auth/config");
    expect(cfg.body.devLogin).toBe(false);
  });

  it("stays off in production even when DEV_LOGIN_ENABLED is explicitly true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_LOGIN_ENABLED", "true");
    // Production refuses to boot without a real secret; unrelated to what is under test.
    vi.stubEnv("JWT_ACCESS_SECRET", "a-real-looking-production-secret-value-0123456789");
    const app = await freshApp();

    const res = await request(app).post("/api/v1/auth/dev-login").send({});
    expect(res.status).toBe(404);

    const cfg = await request(app).get("/api/v1/auth/config");
    expect(cfg.body.devLogin).toBe(false);
  });
});
