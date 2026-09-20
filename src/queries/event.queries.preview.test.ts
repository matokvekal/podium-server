// The card preview on the list responses (routes.thumb_points, sql/046).
//
// Find Tracks and My Rides cards draw their map from `preview`, embedded in the paginated list,
// so scrolling costs one request per page rather than one per card. These tests pin what makes
// that safe: the preview rides on the row, an unbackfilled route still gets one, the COUNT query
// does not pay for it, and a database that has not run sql/046 still serves the list.
// No test database: ../db/pool.js is stubbed and the assertions are on what was asked of it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { selectPublicEvents, selectEventsForUser } = await import("./event.queries.js");

const base = { sort: "newest" as const, limit: 24, offset: 0 };

/** A minimal list row — only what mapEvent / mapEventListItem read. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    code: "A1",
    name: "Ride",
    type: "RIDE",
    participant_count: 0,
    route_id: 7,
    route_distance_km: 12,
    route_elevation_m: 300,
    owner_name: null,
    ...over,
  };
}

const missingThumb = Object.assign(new Error("column r.thumb_points does not exist"), {
  code: "42703",
});

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue({ count: "1" });
});

describe("selectPublicEvents — preview", () => {
  it("selects the stored preview, falling back to the older preview line", async () => {
    query.mockResolvedValue([]);
    await selectPublicEvents(base);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("COALESCE(r.thumb_points, r.preview_points) AS thumb_source");
    expect(sql).toContain("route_summary.thumb_source AS thumb_source");
    // The full line is what the page must NEVER carry.
    expect(sql).not.toContain("track_points");
  });

  it("maps a stored thumb_points onto the row as `preview`", async () => {
    query.mockResolvedValue([
      row({
        thumb_source: {
          p: [
            [32, 35],
            [32.1, 35.1],
          ],
          e: [10, 20],
        },
      }),
    ]);
    const { events } = await selectPublicEvents(base);
    expect(events[0].preview).toEqual({
      points: [
        [32, 35],
        [32.1, 35.1],
      ],
      elevations: [10, 20],
    });
  });

  it("derives a preview from the older preview_points for a route not yet backfilled", async () => {
    const long = Array.from({ length: 300 }, (_, i) => [
      32 + i * 0.0001,
      35 + Math.sin(i / 9) * 0.01,
    ]);
    query.mockResolvedValue([row({ thumb_source: long })]);
    const { events } = await selectPublicEvents(base);
    expect(events[0].preview?.points.length).toBeGreaterThan(2);
    expect(events[0].preview?.points.length).toBeLessThanOrEqual(60);
  });

  it("has a null preview for a ride with no route", async () => {
    query.mockResolvedValue([row({ route_id: null, thumb_source: null })]);
    const { events } = await selectPublicEvents(base);
    expect(events[0].preview).toBeNull();
  });

  it("keeps the preview out of the COUNT query", async () => {
    query.mockResolvedValue([]);
    await selectPublicEvents(base);
    const countSql = queryOne.mock.calls[0][0] as string;
    expect(countSql).not.toContain("thumb_points");
    expect(countSql).not.toContain("thumb_source");
  });

  it("serves the list without previews on a database that has not run sql/046", async () => {
    query.mockRejectedValueOnce(missingThumb).mockResolvedValueOnce([row()]);
    const { events, total } = await selectPublicEvents(base);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).not.toContain("thumb_points");
    expect(events).toHaveLength(1);
    expect(events[0].preview).toBeNull();
    expect(total).toBe(1);
  });

  it("does not swallow an unrelated database error", async () => {
    query.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }));
    await expect(selectPublicEvents(base)).rejects.toThrow("boom");
  });
});

describe("selectEventsForUser — My Rides carries the same preview", () => {
  it("selects the preview lateral and maps it", async () => {
    query.mockResolvedValue([
      row({
        thumb_source: {
          p: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    ]);
    const events = await selectEventsForUser(1);
    expect(query.mock.calls[0][0]).toContain("route_summary.thumb_source AS thumb_source");
    expect(events[0].preview).toEqual({
      points: [
        [1, 2],
        [3, 4],
      ],
    });
  });

  it("falls back cleanly before sql/046", async () => {
    query.mockRejectedValueOnce(missingThumb).mockResolvedValueOnce([row()]);
    const events = await selectEventsForUser(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).not.toContain("thumb_points");
    expect(events[0].preview).toBeNull();
  });
});
