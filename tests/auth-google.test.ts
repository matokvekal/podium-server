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
<<<<<<< HEAD
  name: "Rider One",
  picture: "https://lh3.googleusercontent.com/a/avatar-v1",
=======
  firstName: "Rider",
  lastName: "One",
  displayName: "Rider One",
  picture: "https://lh3.googleusercontent.com/a/rider-one",
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
};

function getMe(app: ReturnType<typeof createApp>, accessToken: string) {
  return request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${accessToken}`);
}

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

  it("stores the profile the ID token already carried, on the first sign-in", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();

    const signIn = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await getMe(app, signIn.body.accessToken);

    expect(me.status).toBe(200);
    expect(me.body.data.firstName).toBe("Rider");
    expect(me.body.data.lastName).toBe("One");
    expect(me.body.data.avatarUrl).toBe("https://lh3.googleusercontent.com/a/rider-one");
    // `name` is not written to nickname on purpose — the rider still picks their own, so
    // profile setup must still be required.
    expect(me.body.data.nickname).toBeNull();
    expect(me.body.data.requiresProfile).toBe(true);
  });

  it("leaves the fields NULL when Google sent no profile", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue({
      subject: "google-subject-2",
      email: "bare@example.com",
      emailVerified: true,
      firstName: null,
      lastName: null,
      displayName: null,
      picture: null,
    });
    const app = createApp();

    const signIn = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await getMe(app, signIn.body.accessToken);

    expect(me.body.data.firstName).toBeNull();
    expect(me.body.data.avatarUrl).toBeNull();
    expect(me.body.data.requiresProfile).toBe(true);
  });

  it("never overwrites an existing user's profile on a later Google sign-in", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue(GOOGLE_IDENTITY);
    const app = createApp();

    const first = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });

    // The rider renames themselves, then Google reports something different next time.
    await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${first.body.accessToken}`)
      .send({ firstName: "Ada", lastName: "Lovelace", nickname: "ada" });

    mocks.verifyGoogleIdToken.mockResolvedValue({
      ...GOOGLE_IDENTITY,
      firstName: "Renamed",
      lastName: "ByGoogle",
      picture: "https://lh3.googleusercontent.com/a/changed",
    });
    const second = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
    const me = await getMe(app, second.body.accessToken);

    expect(second.body.user.id).toBe(first.body.user.id);
    expect(me.body.data.firstName).toBe("Ada");
    expect(me.body.data.lastName).toBe("Lovelace");
    expect(me.body.data.avatarUrl).toBe("https://lh3.googleusercontent.com/a/rider-one");
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
