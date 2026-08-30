// Regression cover for the event LIST queries' route + roster summary — added with the
// "Event list must return route summary data" change. This repo has no test database, so
// ../db/pool.js is stubbed and the assertions are on the SQL text + the shape the mapper
// produces from a representative row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: vi.fn(),
}));

const { selectEventsForUser, selectPublicEvents, updateEventRidePlan } = await import(
  "./event.queries.js"
);

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    code: "01012026A",
    name: "Saturday ride",
    type: "RIDE",
    requires_bib: false,
    starts_at: new Date("2026-01-03T06:00:00Z"),
    ends_at: null,
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    owner_id: 7,
    display_mode: "standard",
    status: "published",
    visibility: "public",
    description: null,
    location: null,
    area: null,
    finished_at: null,
    activity_type: null,
    level: null,
    organizer_group: null,
    team_id: null,
    requires_approval: false,
    is_paused: false,
    elevation_gain_m: null,
    duration_min: null,
    rest_stops: null,
    is_accessible: false,
    show_event_info: true,
    show_participants: false,
    show_route: true,
    show_live_locations: false,
    show_history_locations: false,
    show_results: true,
    // the summary columns the list queries add
    route_distance_km: 80.1,
    route_elevation_m: 640,
    participant_count: 3,
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
});

describe("selectEventsForUser", () => {
  it("pulls route distance/climb and the live roster count in one query", async () => {
    query.mockResolvedValueOnce([eventRow()]);

    const [event] = await selectEventsForUser(7);

    expect(event.distanceKm).toBe(80.1);
    expect(event.elevationGain).toBe(640);
    expect(event.participantCount).toBe(3);

    const sql = query.mock.calls[0][0] as string;
    // one round trip — the route + roster summaries are lateral joins, never a per-row query
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
    expect(sql).toMatch(/event_routes/);
    expect(sql).toMatch(/routes r ON r\.id = er\.route_id/);
    // roster count matches the join-capacity rule: approved + pending, rejected / left excluded
    expect(sql).toMatch(/registration_status IN \('registered', 'approved', 'waiting_approval'\)/);
    expect(sql).toMatch(/left_at IS NULL/);
  });

  it("prefers the organizer's elevation_gain_m over the route's climb", async () => {
    query.mockResolvedValueOnce([eventRow({ elevation_gain_m: 900, route_elevation_m: 820 })]);

    const [event] = await selectEventsForUser(7);

    expect(event.elevationGain).toBe(900);
  });

  it("leaves the summary null when the event has no route or roster", async () => {
    query.mockResolvedValueOnce([
      eventRow({ route_distance_km: null, route_elevation_m: null, participant_count: 0 }),
    ]);

    const [event] = await selectEventsForUser(7);

    expect(event.distanceKm).toBeNull();
    expect(event.elevationGain).toBeNull();
    expect(event.participantCount).toBe(0);
  });
});

describe("selectPublicEvents", () => {
  it("adds the same route + roster summary to the Find Rides list", async () => {
    query.mockResolvedValueOnce([eventRow()]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({
      sort: "soonest",
      limit: 20,
      offset: 0,
    });

    expect(events[0].distanceKm).toBe(80.1);
    expect(events[0].participantCount).toBe(3);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
  });

  it("carries the organizer-set ride plan through the mapper", async () => {
    query.mockResolvedValueOnce([
      eventRow({ duration_min: 165, rest_stops: 2, is_accessible: true }),
    ]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({ sort: "soonest", limit: 20, offset: 0 });

    expect(events[0].durationMin).toBe(165);
    expect(events[0].restStops).toBe(2);
    expect(events[0].isAccessible).toBe(true);
  });
});

describe("updateEventRidePlan", () => {
  it("writes only the columns the caller passed", async () => {
    await updateEventRidePlan("e1", { durationMin: 120 });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toMatch(/duration_min = \$2/);
    expect(sql).not.toMatch(/rest_stops/);
    expect(sql).not.toMatch(/is_accessible/);
    expect(values).toEqual(["e1", 120]);
  });

  it("clears a field when passed null, and sets several at once", async () => {
    await updateEventRidePlan("e1", { durationMin: null, restStops: 0, isAccessible: true });

    const [sql, values] = execute.mock.calls[0];
    expect(sql).toMatch(/duration_min = \$2/);
    expect(sql).toMatch(/rest_stops = \$3/);
    expect(sql).toMatch(/is_accessible = \$4/);
    expect(values).toEqual(["e1", null, 0, true]);
  });

  it("no-ops when nothing was passed", async () => {
    await updateEventRidePlan("e1", {});
    expect(execute).not.toHaveBeenCalled();
  });

  it("swallows a missing-column error on a database without sql/022", async () => {
    execute.mockRejectedValueOnce({ code: "42703" });
    await expect(updateEventRidePlan("e1", { durationMin: 60 })).resolves.toBeUndefined();
  });
});
