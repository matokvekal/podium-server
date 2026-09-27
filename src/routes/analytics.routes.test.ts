// HTTP-level cover for POST /api/v1/analytics/page-view — through the real app (optionalAuth,
// the rate limiter, zod, the real trackAuditEvent non-fatal contract). Only the database is
// replaced (src/db/pool.js), so this never reaches a real Postgres.
//
// trackAuditEvent's own never-throw contract is covered exhaustively in
// src/db/audit/audit.service.test.ts — the "DB failure still 202s" test here only checks that
// THIS endpoint's wiring doesn't add a second failure path on top of it.

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  execute: (...args: unknown[]) => execute(...args),
}));

const { createApp } = await import("../app.js");
const { signAccessToken } = await import("../lib/jwt.js");

const app = createApp();

const URL = "/api/v1/analytics/page-view";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const validBody = {
  path: "/",
  visitorId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  referrer: "https://example.com/",
};

beforeEach(() => {
  execute.mockReset().mockResolvedValue(1);
});

function detailsFromLastInsert(): Record<string, unknown> {
  const [, params] = execute.mock.calls.at(-1) as [string, unknown[]];
  return JSON.parse(params[6] as string);
}

describe("POST /api/v1/analytics/page-view", () => {
  it("stores an anonymous page view with the derived UA fields", async () => {
    const res = await request(app).post(URL).set("User-Agent", CHROME_UA).send(validBody);

    expect(res.status).toBe(202);
    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO analytics_events");
    expect(params[0]).toBe("PAGE_VIEW");
    expect(params[1]).toBeNull(); // user_id — anonymous

    const details = detailsFromLastInsert();
    expect(details).toMatchObject({
      path: "/",
      visitorId: validBody.visitorId,
      sessionId: validBody.sessionId,
      referrer: "https://example.com/",
      isBot: false,
      deviceType: "desktop",
    });
  });

  it("captures the authenticated user_id", async () => {
    const token = await signAccessToken({ sub: "42", role: "RIDER", sid: "1" } as never);
    const res = await request(app)
      .post(URL)
      .set("Authorization", `Bearer ${token}`)
      .set("User-Agent", CHROME_UA)
      .send(validBody);

    expect(res.status).toBe(202);
    expect(execute.mock.calls[0][1][1]).toBe(42);
  });

  it("a forged/expired token is treated as anonymous, not rejected", async () => {
    const res = await request(app)
      .post(URL)
      .set("Authorization", "Bearer not-a-real-token")
      .set("User-Agent", CHROME_UA)
      .send(validBody);

    expect(res.status).toBe(202);
    expect(execute.mock.calls[0][1][1]).toBeNull();
  });

  it("flags a known bot UA and leaves a normal UA unflagged", async () => {
    await request(app).post(URL).set("User-Agent", BOT_UA).send(validBody);
    expect(detailsFromLastInsert().isBot).toBe(true);

    await request(app).post(URL).set("User-Agent", CHROME_UA).send(validBody);
    expect(detailsFromLastInsert().isBot).toBe(false);
  });

  it("referrer is optional", async () => {
    const { referrer: _referrer, ...withoutReferrer } = validBody;
    const res = await request(app).post(URL).set("User-Agent", CHROME_UA).send(withoutReferrer);
    expect(res.status).toBe(202);
    expect(detailsFromLastInsert().referrer).toBeNull();
  });

  it.each([
    { ...validBody, path: "" },
    { ...validBody, visitorId: "not-a-uuid" },
    { ...validBody, sessionId: "not-a-uuid" },
    { path: "/" }, // missing visitorId/sessionId
  ])("rejects an invalid body with 400 and never touches the DB", async (body) => {
    const res = await request(app).post(URL).set("User-Agent", CHROME_UA).send(body);
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a DB failure still answers 202 — analytics must never break the caller", async () => {
    execute.mockRejectedValueOnce(new Error("connection terminated"));
    const res = await request(app).post(URL).set("User-Agent", CHROME_UA).send(validBody);
    expect(res.status).toBe(202);
  });
});
