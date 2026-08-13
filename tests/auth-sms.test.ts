import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTP_MAX_ATTEMPTS } from "../src/modules/sms/otp.constants.js";
import { resetFakeDb } from "./support/fake-db.js";

const mocks = vi.hoisted(() => ({
  sendOtp: vi.fn(async (_phone: string, _code: string) => {}),
}));

vi.mock("../src/modules/sms/sms-provider.js", () => ({
  getSmsProvider: () => ({ sendOtp: mocks.sendOtp }),
}));

vi.mock("../src/db/pool.js", async () => import("./support/fake-db.js"));

const { createApp } = await import("../src/app.js");

const PHONE = "+15551234567";

function lastSentCode(): string {
  const call = mocks.sendOtp.mock.calls.at(-1);
  if (!call) throw new Error("sendOtp was never called");
  return call[1];
}

beforeEach(() => {
  resetFakeDb();
  mocks.sendOtp.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SMS OTP flow", () => {
  it("requests a code and verifies it to get tokens", async () => {
    const app = createApp();

    const requestRes = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.challengeId).toEqual(expect.any(Number));
    expect(mocks.sendOtp).toHaveBeenCalledTimes(1);

    const code = lastSentCode();
    const verifyRes = await request(app)
      .post("/api/v1/auth/sms/verify")
      .send({ challengeId: requestRes.body.challengeId, code });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.accessToken).toEqual(expect.any(String));
    expect(verifyRes.body.refreshToken).toEqual(expect.any(String));
    expect(verifyRes.body.requiresProfile).toBe(true);
  });

  it("rejects an invalid phone number", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/auth/sms/request").send({ phone: "not-a-phone" });
    expect(res.status).toBe(400);
  });

  it("rejects a wrong code without consuming the challenge", async () => {
    const app = createApp();
    const requestRes = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });

    const res = await request(app)
      .post("/api/v1/auth/sms/verify")
      .send({ challengeId: requestRes.body.challengeId, code: "000000" });

    expect(res.status).toBe(401);
  });

  it("locks out after too many incorrect attempts", async () => {
    const app = createApp();
    const requestRes = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    const { challengeId } = requestRes.body;

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await request(app).post("/api/v1/auth/sms/verify").send({ challengeId, code: "000000" });
    }

    const res = await request(app)
      .post("/api/v1/auth/sms/verify")
      .send({ challengeId, code: "000000" });

    expect(res.status).toBe(429);
  });

  it("rejects an expired code", async () => {
    const app = createApp();
    const requestRes = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    const code = lastSentCode();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000); // past the 5-minute expiry

    const res = await request(app)
      .post("/api/v1/auth/sms/verify")
      .send({ challengeId: requestRes.body.challengeId, code });

    expect(res.status).toBe(400);
  });

  it("enforces the resend cooldown", async () => {
    const app = createApp();
    const first = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    expect(second.status).toBe(429);
  });

  it("allows a new request once the cooldown has passed", async () => {
    const app = createApp();
    const first = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    expect(first.status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 1000);

    const second = await request(app).post("/api/v1/auth/sms/request").send({ phone: PHONE });
    expect(second.status).toBe(200);
  });
});
