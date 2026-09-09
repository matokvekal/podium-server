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

const {
  selectEventsForUser,
  selectPublicEvents,
  selectPublicEventAreas,
  updateEvent,
  updateEventRidePlan,
} = await import("./event.queries.js");

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
    has_support_vehicle: false,
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
      eventRow({
        duration_min: 165,
        rest_stops: 2,
        is_accessible: true,
        has_support_vehicle: true,
      }),
    ]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({ sort: "soonest", limit: 20, offset: 0 });

    expect(events[0].durationMin).toBe(165);
    expect(events[0].restStops).toBe(2);
    expect(events[0].isAccessible).toBe(true);
    expect(events[0].hasSupportVehicle).toBe(true);
  });

  it("reads has_support_vehicle as false on a database without sql/024", async () => {
    // `SELECT *` on a database that has not had the migration leaves the key absent, which is
    // exactly what an old ride means: no support vehicle stated.
    const row = eventRow({});
    delete (row as Record<string, unknown>).has_support_vehicle;
    query.mockResolvedValueOnce([row]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({ sort: "soonest", limit: 20, offset: 0 });

    expect(events[0].hasSupportVehicle).toBe(false);
  });
});

describe("selectPublicEvents — Browse tracks filters and sort", () => {
  it("binds multi-select activity type / level as arrays matched with = ANY", async () => {
    query.mockResolvedValueOnce([eventRow()]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    await selectPublicEvents({
      sort: "newest",
      limit: 24,
      offset: 0,
      activityType: ["road", "gravel"],
      level: ["elite"],
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/e\.activity_type = ANY\(\$3::text\[\]\)/);
    expect(sql).toMatch(/e\.level = ANY\(\$4::text\[\]\)/);
    expect(params[2]).toEqual(["road", "gravel"]);
    expect(params[3]).toEqual(["elite"]);
  });

  it("filters on area, the attached route's distance and the effective climb", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });

    await selectPublicEvents({
      sort: "newest",
      limit: 24,
      offset: 0,
      areas: ["Galilee", "Negev"],
      minDistanceKm: 40,
      maxDistanceKm: 120,
      minClimbM: 500,
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/TRIM\(e\.area\) = ANY\(\$6::text\[\]\)/);
    expect(sql).toMatch(/route_summary\.distance_km >= \$7/);
    expect(sql).toMatch(/route_summary\.distance_km <= \$8/);
    expect(sql).toMatch(/COALESCE\(e\.elevation_gain_m, route_summary\.elevation_m\) >= \$9/);
    expect(params[5]).toEqual(["Galilee", "Negev"]);
    expect(params[6]).toBe(40);
    expect(params[7]).toBe(120);
    expect(params[8]).toBe(500);
    expect(params[9]).toBeNull();
  });

  it("turns duration buckets into an OR-group over duration_min", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });

    await selectPublicEvents({
      sort: "newest",
      limit: 24,
      offset: 0,
      durationBuckets: ["1to2", "gt5"],
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$11::text\[\] IS NULL OR \(e\.duration_min IS NOT NULL/);
    expect(sql).toMatch(/'gt5' {2}= ANY\(\$11::text\[\]\) AND e\.duration_min >= 300/);
    expect(params[10]).toEqual(["1to2", "gt5"]);
  });

  it("matches a ride code or id through q", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });

    await selectPublicEvents({ sort: "newest", limit: 24, offset: 0, q: "06092026A" });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/e\.code ILIKE \$1/);
    expect(sql).toMatch(/e\.id::text = \$1/);
    expect(sql).toMatch(/e\.area ILIKE '%' \|\| \$1 \|\| '%'/);
  });

  it("whitelists every new sort with NULLS LAST and a stable tie-break on e.id", async () => {
    const sorts = [
      "oldest",
      "distance_asc",
      "distance_desc",
      "elevation_asc",
      "elevation_desc",
      "duration_asc",
      "duration_desc",
      "downloads_asc",
      "downloads_desc",
      "name_asc",
    ] as const;

    for (const sort of sorts) {
      query.mockResolvedValueOnce([]);
      queryOne.mockResolvedValueOnce({ count: "0" });
      await selectPublicEvents({ sort, limit: 24, offset: 0 });
      const [sql] = query.mock.calls.at(-1) as [string];
      expect(sql).toMatch(/ORDER BY [^\n]+, e\.id LIMIT \$15 OFFSET \$16/);
      if (sort !== "name_asc" && sort !== "oldest") {
        expect(sql).toMatch(/NULLS LAST, e\.created_at DESC, e\.id/);
      }
    }
  });

  it("downloads_* order by the copy_summary lateral's count", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });
    await selectPublicEvents({ sort: "downloads_desc", limit: 24, offset: 0 });
    const [sql] = query.mock.calls.at(-1) as [string];
    expect(sql).toMatch(/FROM route_copies rc\s+WHERE rc\.route_id = route_summary\.route_id/);
    expect(sql).toMatch(/copy_summary\.download_count DESC NULLS LAST/);
  });

  it("filters on country and region", async () => {
    query.mockResolvedValueOnce([eventRow({ country: "IL", region: "north" })]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({
      sort: "newest",
      limit: 24,
      offset: 0,
      country: "IL",
      region: "north",
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$12::text IS NULL OR e\.country = \$12/);
    expect(sql).toMatch(/\$13::text IS NULL OR e\.region = \$13/);
    expect(params[11]).toBe("IL");
    expect(params[12]).toBe("north");
    expect(events[0].country).toBe("IL");
    expect(events[0].region).toBe("north");
  });

  it("uniqueTracks keeps one origin ride per route", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });

    await selectPublicEvents({ sort: "newest", limit: 24, offset: 0, uniqueTracks: true });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$14::boolean IS NOT TRUE OR route_summary\.route_id IS NOT NULL/);
    expect(sql).toMatch(/\$14::boolean IS NOT TRUE OR NOT EXISTS/);
    expect(sql).toMatch(/copied_from_route_id IS NULL\s+AND e2\.copied_from_event_id IS NULL/);
    expect(params[13]).toBe(true);
  });

  it("without uniqueTracks the dedup clauses are inert (param null)", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "0" });
    await selectPublicEvents({ sort: "newest", limit: 24, offset: 0 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[13]).toBeNull();
  });

  it("carries downloads through the mapper when the lateral reports one", async () => {
    query.mockResolvedValueOnce([eventRow({ download_count: 7, route_id: 42 })]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({ sort: "newest", limit: 24, offset: 0 });

    expect(events[0].downloads).toBe(7);
    expect(events[0].routeId).toBe(42);
  });

  it("falls to the legacy query when route_copies is missing (42P01)", async () => {
    query.mockRejectedValueOnce({ code: "42P01" });
    query.mockResolvedValueOnce([eventRow()]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    const { events } = await selectPublicEvents({
      sort: "downloads_desc",
      limit: 24,
      offset: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0].downloads).toBeNull();
    const [legacySql] = query.mock.calls[1] as [string];
    expect(legacySql).not.toMatch(/route_copies/);
  });

  it("counts through the same lateral joins the distance/climb filters read", async () => {
    query.mockResolvedValueOnce([]);
    queryOne.mockResolvedValueOnce({ count: "5" });

    const { total } = await selectPublicEvents({
      sort: "newest",
      limit: 24,
      offset: 0,
      minDistanceKm: 10,
    });

    const [countSql] = queryOne.mock.calls[0] as [string];
    expect(countSql).toMatch(/COUNT\(\*\)::text/);
    expect(countSql).toMatch(/LEFT JOIN LATERAL/);
    expect(total).toBe(5);
  });

  it("still accepts a single-value activityType list (the Find Rides pill)", async () => {
    query.mockResolvedValueOnce([eventRow()]);
    queryOne.mockResolvedValueOnce({ count: "1" });

    await selectPublicEvents({ sort: "soonest", limit: 20, offset: 0, activityType: ["road"] });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toEqual(["road"]);
  });
});

describe("selectPublicEventAreas", () => {
  it("returns the distinct trimmed areas over the public predicate", async () => {
    query.mockResolvedValueOnce([{ area: "Galilee" }, { area: "Negev" }]);

    const areas = await selectPublicEventAreas();

    expect(areas).toEqual(["Galilee", "Negev"]);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/SELECT DISTINCT TRIM\(area\) AS area/);
    expect(sql).toMatch(/visibility = 'public'/);
    expect(sql).toMatch(/status NOT IN \('cancelled', 'draft'\)/);
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
    await updateEventRidePlan("e1", {
      durationMin: null,
      restStops: 0,
      isAccessible: true,
      hasSupportVehicle: true,
    });

    const [sql, values] = execute.mock.calls[0];
    expect(sql).toMatch(/duration_min = \$2/);
    expect(sql).toMatch(/rest_stops = \$3/);
    expect(sql).toMatch(/is_accessible = \$4/);
    expect(sql).toMatch(/has_support_vehicle = \$5/);
    expect(values).toEqual(["e1", null, 0, true, true]);
  });

  it("writes has_support_vehicle on its own, including turning it back off", async () => {
    await updateEventRidePlan("e1", { hasSupportVehicle: false });

    const [sql, values] = execute.mock.calls[0];
    expect(sql).toMatch(/has_support_vehicle = \$2/);
    expect(sql).not.toMatch(/duration_min/);
    expect(values).toEqual(["e1", false]);
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

// A description used to be impossible to REMOVE. Every column in updateEvent is written with
// COALESCE($n, column), which reads null as "the caller left this out" — correct for a name,
// wrong for the one field an organizer can legitimately want to empty. Clearing the textarea
// restored the old text on the next load.
//
// description is now written with a CASE keyed on a separate "was this key present" parameter,
// so the two cases below are genuinely different statements' worth of behaviour, not one.
describe("updateEvent description", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([eventRow()]);
  });

  /** The trailing boolean is the "description was provided" flag the CASE reads. */
  const flagOf = (params: unknown[]) => params[params.length - 1];
  const descriptionOf = (params: unknown[]) => params[8];

  it("does not write the column at all when description is omitted", async () => {
    await updateEvent("11111111-1111-1111-1111-111111111111", { name: "New name" });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(flagOf(params)).toBe(false);
  });

  it("clears the column when description is explicitly null", async () => {
    await updateEvent("11111111-1111-1111-1111-111111111111", { description: null });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(flagOf(params)).toBe(true);
    expect(descriptionOf(params)).toBeNull();
  });

  it("sets the column when description is a real string", async () => {
    await updateEvent("11111111-1111-1111-1111-111111111111", {
      description: "06:00 from the square",
    });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(flagOf(params)).toBe(true);
    expect(descriptionOf(params)).toBe("06:00 from the square");
  });

  it("writes description with a CASE, not a COALESCE — the other columns keep COALESCE", async () => {
    await updateEvent("11111111-1111-1111-1111-111111111111", { name: "New name" });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("description = CASE WHEN");
    expect(sql).not.toContain("description = COALESCE");
    // The guard that this fix stayed surgical: name is still written the old way.
    expect(sql).toContain("name = COALESCE");
  });
});
