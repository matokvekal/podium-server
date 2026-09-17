// HTTP-level cover for the share/link-group routes, through the real app — route table,
// middleware chain and error handler.
//
// Two things only this level can check:
//
//   1. ⚠ THE APP STILL BOOTS. createApp() builds the route table, and path-to-regexp v8 (which
//      Express 5 uses) throws at BOOT for the param syntaxes it dropped — ":codes+", ":codes*",
//      an inline regex group. That mistake takes the whole server down rather than one route,
//      and every test in this file would fail on the import above, which is the point.
//   2. "/share/:codes" IS NOT SWALLOWED BY "/:eventId". It cannot be, because it is two
//      segments and a param never spans a "/" — but that is a property of the router, not of
//      our comments, so it is asserted rather than asserted-in-prose.
//
// The assertions are about WHICH HANDLER WAS REACHED, never about ride data. There is no test
// database, and whether one happens to be reachable on the machine running this must not change
// the result: a request for codes nobody created is free to answer 404 ("no rides for that
// link") or 500 (no database at all), so neither status is asserted on. What is asserted is the
// status that could only come from the wrong handler.

import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const app = createApp();

describe("GET /api/v1/events/share/:codes", () => {
  it("is routed to the share handler, not rejected as a malformed event id", async () => {
    const res = await request(app).get("/api/v1/events/share/19092026A-19092026B");
    // A 400 here would mean eventIdParamSchema saw "share" and refused it as a non-UUID —
    // i.e. "/:eventId" had won the match. Whether these codes resolve depends on the database
    // (a 404 "no rides for that link" is a perfectly good answer for codes nobody created),
    // so the routing assertion is on the status that could ONLY come from the wrong handler.
    expect(res.status).not.toBe(400);
  });

  it("refuses more than three codes at the SHARE schema — proof the share handler matched", async () => {
    const res = await request(app).get("/api/v1/events/share/A-B-C-D");
    expect(res.status).toBe(400);
    // shareCodesParamSchema's message, not eventIdParamSchema's "Invalid uuid".
    expect(String(res.body?.error?.message ?? res.text)).toMatch(/between 1 and 3 rides/i);
  });

  it("is open to a signed-out visitor — a shared link is the app's front door", async () => {
    const res = await request(app).get("/api/v1/events/share/19092026A");
    expect(res.status).not.toBe(401);
  });

  it("ignores a forged token rather than 401ing, the way optionalAuth routes do", async () => {
    const res = await request(app)
      .get("/api/v1/events/share/19092026A")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/v1/events/share — a link that lost its codes", () => {
  it("says the codes are missing instead of complaining about an event id", async () => {
    const res = await request(app).get("/api/v1/events/share");
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? res.text)).toMatch(/code/i);
  });
});

describe("the link-group mutations require an identity", () => {
  it("401s PUT /:eventId/link-group when signed out", async () => {
    const res = await request(app)
      .put("/api/v1/events/11111111-1111-1111-1111-111111111111/link-group")
      .send({ eventIds: [] });
    expect(res.status).toBe(401);
  });

  it("401s DELETE /:eventId/link-group when signed out", async () => {
    const res = await request(app).delete(
      "/api/v1/events/11111111-1111-1111-1111-111111111111/link-group",
    );
    expect(res.status).toBe(401);
  });

  it("the routes exist — neither is a 404 from an unregistered path", async () => {
    const put = await request(app)
      .put("/api/v1/events/11111111-1111-1111-1111-111111111111/link-group")
      .send({});
    const del = await request(app).delete(
      "/api/v1/events/11111111-1111-1111-1111-111111111111/link-group",
    );
    expect(put.status).not.toBe(404);
    expect(del.status).not.toBe(404);
  });
});

describe("POST /api/v1/events/:eventId/leave", () => {
  // ⚠ The client has called this path for a long time against nothing at all; until this work
  // it was genuinely unregistered and answered 404. This is the regression guard for that.
  it("exists", async () => {
    const res = await request(app).post(
      "/api/v1/events/11111111-1111-1111-1111-111111111111/leave",
    );
    expect(res.status).not.toBe(404);
  });

  it("401s when signed out — leaving is an action on your own membership", async () => {
    const res = await request(app).post(
      "/api/v1/events/11111111-1111-1111-1111-111111111111/leave",
    );
    expect(res.status).toBe(401);
  });
});
