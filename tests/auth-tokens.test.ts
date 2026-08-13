import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeDb, setUserActive } from "./support/fake-db.js";

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
  });
  const res = await request(app).post("/api/v1/auth/google").send({ idToken: "good-token" });
  return res.body as { accessToken: string; refreshToken: string; user: { id: number } };
}

beforeEach(() => {
  resetFakeDb();
  mocks.verifyGoogleIdToken.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token refresh, rotation, and logout", () => {
  it("issues a new token pair and invalidates the old refresh token", async () => {
    const app = createApp();
    const { refreshToken } = await signIn(app);

    const refreshRes = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);

    // Reusing the now-rotated-away token must fail (theft/reuse detection).
    const reuseRes = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(reuseRes.status).toBe(401);
  });

  it("accepts the newly rotated refresh token", async () => {
    const app = createApp();
    const { refreshToken } = await signIn(app);

    const first = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    const second = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first.body.refreshToken });

    expect(second.status).toBe(200);
  });

  it("rejects a malformed/tampered refresh token", async () => {
    const app = createApp();
    await signIn(app);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired refresh token", async () => {
    const app = createApp();
    const { refreshToken } = await signIn(app);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000); // past the 30-day default expiry

    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it("logs out and revokes the session, so its refresh token stops working", async () => {
    const app = createApp();
    const { accessToken, refreshToken } = await signIn(app);

    const logoutRes = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it("rejects logout without an access token", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/auth/logout");
    expect(res.status).toBe(401);
  });

  it("rejects a tampered access token on a protected route", async () => {
    const app = createApp();
    const { accessToken } = await signIn(app);
    // Flip a character in the middle of the payload segment — flipping the very last character
    // of a base64url JWT can leave the decoded signature bytes unchanged (trailing padding bits
    // aren't significant), so this targets a position guaranteed to change the decoded content.
    const middle = Math.floor(accessToken.length / 2);
    const flipped = accessToken[middle] === "a" ? "b" : "a";
    const tampered = accessToken.slice(0, middle) + flipped + accessToken.slice(middle + 1);

    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it("rejects a refresh for a deactivated user and revokes the session", async () => {
    const app = createApp();
    const { refreshToken, user } = await signIn(app);

    setUserActive(user.id, false);

    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(403);

    // Reactivating doesn't resurrect the session — refresh() revoked it on the way out.
    setUserActive(user.id, true);
    const retry = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(retry.status).toBe(401);
  });

  it("keeps independent sessions for the same user isolated", async () => {
    const app = createApp();
    const sessionA = await signIn(app);
    const sessionB = await signIn(app);

    expect(sessionA.user.id).toBe(sessionB.user.id);
    expect(sessionA.refreshToken).not.toBe(sessionB.refreshToken);

    // Logging out session A must not affect session B's refresh token.
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${sessionA.accessToken}`);

    const refreshA = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: sessionA.refreshToken });
    expect(refreshA.status).toBe(401);

    const refreshB = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: sessionB.refreshToken });
    expect(refreshB.status).toBe(200);
  });

  it("logout-all revokes every session for the user", async () => {
    const app = createApp();
    const sessionA = await signIn(app);
    const sessionB = await signIn(app);

    const logoutAllRes = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("Authorization", `Bearer ${sessionA.accessToken}`);
    expect(logoutAllRes.status).toBe(204);

    const refreshA = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: sessionA.refreshToken });
    expect(refreshA.status).toBe(401);

    const refreshB = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: sessionB.refreshToken });
    expect(refreshB.status).toBe(401);
  });

  it("rejects logout-all without an access token", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/auth/logout-all");
    expect(res.status).toBe(401);
  });
});
