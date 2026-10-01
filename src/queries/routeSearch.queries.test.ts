// Cover for folding a ride into its route's search text (sql/057).
//
// The property worth protecting: events.route_info_processed goes TRUE only after the route's
// text was written, inside the same transaction — so a failure anywhere leaves the ride FALSE
// for the next run. No test database in this repo; withTransaction is stubbed with a fake
// transaction that records every statement in order.

import { beforeEach, describe, expect, it, vi } from "vitest";

const txQuery = vi.fn();
const txQueryOne = vi.fn();
const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: (...a: unknown[]) => execute(...a),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: (...a: unknown[]) => txQuery(...a),
      queryOne: (...a: unknown[]) => txQueryOne(...a),
    }),
}));

const { applyEventToRouteSearchText, markEventRouteInfoPending } = await import(
  "./routeSearch.queries.js"
);

const EVENT = "11111111-1111-1111-1111-111111111111";

function ev(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    name: "Latrun loop",
    visibility: "public",
    status: "published",
    region: "center",
    route_info_processed: false,
    ...overrides,
  };
}

function lockedEvent(overrides: Record<string, unknown> = {}, routeId: number | null = 42) {
  return { ev: ev(overrides), route_id: routeId === null ? null : String(routeId) };
}

const ROUTE = { name: null, place_name: null, route_type: null, ai_search_text: null };

beforeEach(() => {
  txQuery.mockReset().mockResolvedValue([]);
  txQueryOne.mockReset();
  execute.mockReset().mockResolvedValue(1);
});

function statements(): string[] {
  return txQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());
}

describe("applyEventToRouteSearchText", () => {
  it("writes the route's text FIRST, then marks the ride processed", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent()).mockResolvedValueOnce(ROUTE);

    expect(await applyEventToRouteSearchText(EVENT)).toEqual({ outcome: "merged", routeId: 42 });

    const [routeWrite, eventWrite] = statements();
    expect(routeWrite).toMatch(
      /^UPDATE routes SET ai_search_text = \$2, ai_search_updated_at = NOW\(\), ai_search_version = \$3/,
    );
    expect(txQuery.mock.calls[0][1]).toEqual([42, "Ride: Latrun loop\nRegion: Center / מרכז", 1]);
    expect(eventWrite).toMatch(
      /^UPDATE events SET route_info_processed = TRUE WHERE id = \$1 AND route_info_processed = FALSE/,
    );
    expect(statements()).toHaveLength(2);
  });

  it("locks the ride and its route before reading them", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent()).mockResolvedValueOnce(ROUTE);

    await applyEventToRouteSearchText(EVENT);

    expect(String(txQueryOne.mock.calls[0][0])).toMatch(/FOR UPDATE OF e/);
    expect(String(txQueryOne.mock.calls[1][0])).toMatch(/FOR UPDATE/);
  });

  it("marks the ride processed without touching the route when it adds nothing new", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent()).mockResolvedValueOnce({
      ...ROUTE,
      ai_search_text: "Ride: Latrun loop\nRegion: Center / מרכז",
    });

    expect(await applyEventToRouteSearchText(EVENT)).toEqual({ outcome: "unchanged", routeId: 42 });
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(/^UPDATE events SET route_info_processed = TRUE/);
  });

  it("leaves the ride FALSE when the route write fails — the error reaches the transaction", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent()).mockResolvedValueOnce(ROUTE);
    txQuery.mockRejectedValueOnce(new Error("deadlock detected"));

    await expect(applyEventToRouteSearchText(EVENT)).rejects.toThrow("deadlock detected");
    // The events UPDATE was never even sent.
    expect(statements().some((s) => s.startsWith("UPDATE events"))).toBe(false);
  });

  it.each([
    ["a private ride", { visibility: "private" }],
    ["a 'registered' ride", { visibility: "registered" }],
    ["a draft", { status: "draft" }],
    ["a cancelled ride", { status: "cancelled" }],
  ])("does not let %s contribute, and leaves it unprocessed", async (_label, overrides) => {
    txQueryOne.mockResolvedValueOnce(lockedEvent(overrides));

    expect((await applyEventToRouteSearchText(EVENT)).outcome).toBe("ineligible");
    expect(txQuery).not.toHaveBeenCalled();
  });

  it("does nothing for a ride with no route", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent({}, null));

    expect(await applyEventToRouteSearchText(EVENT)).toEqual({
      outcome: "no-route",
      routeId: null,
    });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it("does nothing for a ride already processed", async () => {
    txQueryOne.mockResolvedValueOnce(lockedEvent({ route_info_processed: true }));

    expect((await applyEventToRouteSearchText(EVENT)).outcome).toBe("already-processed");
    expect(txQuery).not.toHaveBeenCalled();
  });

  it("tolerates a database missing an optional events column (the ride is read as JSON)", async () => {
    const { region: _region, ...withoutRegion } = ev();
    txQueryOne
      .mockResolvedValueOnce({ ev: withoutRegion, route_id: "42" })
      .mockResolvedValueOnce(ROUTE);

    expect((await applyEventToRouteSearchText(EVENT)).outcome).toBe("merged");
    expect(txQuery.mock.calls[0][1]).toEqual([42, "Ride: Latrun loop", 1]);
  });
});

describe("markEventRouteInfoPending", () => {
  it("only flips the ride's flag back to FALSE — never the route", async () => {
    await markEventRouteInfoPending(EVENT);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(String(execute.mock.calls[0][0])).toMatch(
      /^UPDATE events SET route_info_processed = FALSE WHERE id = \$1 AND route_info_processed = TRUE$/,
    );
    expect(execute.mock.calls[0][1]).toEqual([EVENT]);
  });
});
