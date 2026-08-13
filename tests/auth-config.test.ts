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

describe("auth provider configuration", () => {
  it("GET /auth/config reflects the default enabled providers", async () => {
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).get("/api/v1/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(["GOOGLE", "SMS"]);
  });

  it("GET /auth/config reflects a restricted provider set", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "GOOGLE");
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).get("/api/v1/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(["GOOGLE"]);
  });

  it("rejects POST /auth/google when GOOGLE is disabled", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "SMS");
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/google").send({ idToken: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("AUTH_PROVIDER_DISABLED");
  });

  it("rejects POST /auth/sms/request when SMS is disabled", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "GOOGLE");
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/sms/request").send({ phone: "+15551234567" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("AUTH_PROVIDER_DISABLED");
  });

  it("fails startup on an unknown provider name", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "GOOGLE,CARRIER_PIGEON");
    vi.resetModules();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("../src/config/env.js")).rejects.toThrow("process.exit called");
  });
});
