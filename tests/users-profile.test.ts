import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../src/lib/google-auth.js", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  InvalidGoogleTokenError: class InvalidGoogleTokenError extends Error {},
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

const { createApp } = await import("../src/app.js");

async function signIn(app: ReturnType<typeof createApp>) {
  mocks.verifyGoogleIdToken.mockResolvedValue({
    subject: "google-subject-1",
    email: "rider@example.com",
    emailVerified: true,
    name: "Rider One",
    picture: "https://lh3.googleusercontent.com/a/avatar-v1",
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body as { accessToken: string };
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("PATCH /api/v1/users/me", () => {
  it("requires authentication", async () => {
    const app = createApp();
    const res = await request(app).patch("/api/v1/users/me").send({ firstName: "Ada" });
    expect(res.status).toBe(401);
  });

  it("GET returns the profile the PWA needs on a cold start", async () => {
    const app = createApp();
    const { accessToken } = await signIn(app);

    const unauthenticated = await request(app).get("/api/v1/users/me");
    expect(unauthenticated.status).toBe(401);

    const res = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toEqual(expect.any(Number));
    expect(res.body.data.role).toBe("RIDER");
    expect(res.body.data.requiresProfile).toBe(true);
    expect(res.body.data.avatarUrl).toBe("https://lh3.googleusercontent.com/a/avatar-v1");
  });

  it("starts with requiresProfile true and flips to false once fields are complete", async () => {
    const app = createApp();
    const { accessToken } = await signIn(app);

    const partial = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ firstName: "Ada" });
    expect(partial.status).toBe(200);
    expect(partial.body.data.requiresProfile).toBe(true);

    const complete = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ lastName: "Lovelace", nickname: "Ada" });
    expect(complete.status).toBe(200);
    expect(complete.body.data.requiresProfile).toBe(false);
    expect(complete.body.data.firstName).toBe("Ada");
    expect(complete.body.data.lastName).toBe("Lovelace");
  });

  it("leaves emergencyPhone optional", async () => {
    const app = createApp();
    const { accessToken } = await signIn(app);

    const res = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ firstName: "Ada", lastName: "Lovelace", nickname: "Ada" });

    expect(res.status).toBe(200);
    expect(res.body.data.requiresProfile).toBe(false);
    expect(res.body.data.emergencyPhone).toBeNull();
  });
});
