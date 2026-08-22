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

const GOOGLE_IDENTITY = {
  subject: "google-subject-1",
  email: "rider@example.com",
  emailVerified: true,
  name: "Rider One",
  picture: "https://lh3.googleusercontent.com/a/avatar-v1",
};

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

describe("POST /api/v1/auth/google", () => {
  it("registers a new user on first sign-in and requires profile completion", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("RIDER");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.requiresProfile).toBe(true);
  });

  it("returns the same user on a second sign-in with the same Google subject", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();

    const first = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const second = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("rejects an invalid Google ID token", async () => {
    mocks.verifyGoogleIdToken.mockRejectedValue(new Error("invalid"));
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/google").send({ idToken: "bad-token" });

    expect(res.status).toBe(401);
  });

  it("rejects a token whose email is not verified", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue({ ...GOOGLE_IDENTITY, emailVerified: false });
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });

    expect(res.status).toBe(401);
  });

  it("rejects a missing idToken body", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/auth/google").send({});
    expect(res.status).toBe(400);
  });

  it("captures avatar_url from the Google picture on first sign-in", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();

    const signIn = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${signIn.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.avatarUrl).toBe(GOOGLE_IDENTITY.picture);
  });

  it("refreshes avatar_url on re-sign-in when the Google picture changes", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();
    await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });

    const newPicture = "https://lh3.googleusercontent.com/a/avatar-v2";
    mocks.verifyGoogleIdToken.mockResolvedValue({ ...GOOGLE_IDENTITY, picture: newPicture });
    const second = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${second.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.avatarUrl).toBe(newPicture);
  });

  it("does not set avatar_url when the Google token has no picture", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue({ ...GOOGLE_IDENTITY, picture: null });
    const app = createApp();

    const signIn = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${signIn.body.accessToken}`);

    expect(me.body.data.avatarUrl).toBeNull();
  });
});
