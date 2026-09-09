// The load-bearing property of this module: it NEVER throws. A business flow that fires
// `void trackAuditEvent(...)` after it has already succeeded must be unaffected by anything the
// analytics write does.

import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const loggerWarn = vi.fn();

vi.mock("../pool.js", () => ({
  execute: (...args: unknown[]) => execute(...args),
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { warn: (...args: unknown[]) => loggerWarn(...args), info: vi.fn(), debug: vi.fn() },
}));

const { trackAuditEvent } = await import("./audit.service.js");
const { insertAnalyticsEvent } = await import("./audit.queries.js");

beforeEach(() => {
  execute.mockReset().mockResolvedValue(1);
  loggerWarn.mockReset();
});

describe("insertAnalyticsEvent — the INSERT", () => {
  it("passes every field through in column order, details as a JSON string", async () => {
    await insertAnalyticsEvent({
      type: "RIDE_CREATED",
      userId: 7,
      rideId: "11111111-2222-3333-4444-555555555555",
      routeId: 42,
      countryCode: "il",
      rideVisibility: "public",
      details: { via: "event-route" },
    });

    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO analytics_events");
    expect(params).toEqual([
      "RIDE_CREATED",
      7,
      "11111111-2222-3333-4444-555555555555",
      42,
      "IL", // upper-cased on write
      "public",
      JSON.stringify({ via: "event-route" }),
    ]);
  });

  it("sends null for every omitted field and {} for absent details", async () => {
    await insertAnalyticsEvent({ type: "USER_REGISTERED" });

    expect(execute.mock.calls[0][1]).toEqual([
      "USER_REGISTERED",
      null,
      null,
      null,
      null,
      null,
      "{}",
    ]);
  });

  it("treats explicit null the same as omitted", async () => {
    await insertAnalyticsEvent({
      type: "RIDE_JOINED",
      userId: 3,
      rideId: null,
      countryCode: null,
      rideVisibility: null,
    });
    const params = execute.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(3);
    expect(params.slice(2)).toEqual([null, null, null, null, "{}"]);
  });
});

describe("trackAuditEvent — non-fatal", () => {
  it("writes the row on the happy path", async () => {
    await trackAuditEvent({ type: "ROUTE_COPIED", userId: 1, routeId: 9 });
    expect(execute).toHaveBeenCalledOnce();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does NOT throw when the insert fails, and logs a warning", async () => {
    execute.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(trackAuditEvent({ type: "RIDE_CREATED", userId: 1 })).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledOnce();
    expect(loggerWarn.mock.calls[0][1]).toMatch(/non-fatal/i);
  });

  it("does NOT throw when analytics_events is missing (42P01), and names the migration", async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error('relation "analytics_events" does not exist'), { code: "42P01" }));

    await expect(trackAuditEvent({ type: "RIDE_JOINED", userId: 1 })).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledOnce();
    expect(loggerWarn.mock.calls[0][1]).toMatch(/sql\/031/);
  });

  it("does NOT throw when the module itself errors unexpectedly", async () => {
    execute.mockImplementationOnce(() => {
      throw "not even an Error";
    });
    await expect(trackAuditEvent({ type: "ROUTE_CREATED" })).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledOnce();
  });
});
