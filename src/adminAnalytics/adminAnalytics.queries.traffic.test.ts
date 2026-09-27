// Cover for the two PAGE_VIEW-reading queries (dailyTraffic, topPages). Same harness as the
// rest of this repo's query tests: no test database, so ../db/pool.js is stubbed and
// assertions are on the SQL text plus the shape the mapper returns.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../db/pool.js", () => ({ query: (...args: unknown[]) => query(...args) }));

const { dailyTraffic, topPages } = await import("./adminAnalytics.queries.js");

beforeEach(() => {
  query.mockReset();
});

describe("dailyTraffic", () => {
  it("filters to PAGE_VIEW, buckets by day, and maps every column", async () => {
    query.mockResolvedValue([
      {
        date: "2026-09-07",
        page_views: 60,
        unique_visitors: 40,
        logged_in: 15,
        anonymous: 25,
        bots: 5,
        human_page_views: 55,
      },
    ]);

    const rows = await dailyTraffic(30);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/event_type = 'PAGE_VIEW'/);
    expect(sql).toMatch(/GROUP BY event_time::date/);
    expect(sql).toMatch(/ORDER BY event_time::date DESC/);
    expect(params).toEqual([30]);

    expect(rows).toEqual([
      {
        date: "2026-09-07",
        pageViews: 60,
        uniqueVisitors: 40,
        loggedIn: 15,
        anonymous: 25,
        bots: 5,
        humanPageViews: 55,
      },
    ]);
  });

  it("does not subtract bots from pageViews/uniqueVisitors — bots is informational only", async () => {
    query.mockResolvedValue([
      {
        date: "2026-09-07",
        page_views: 10,
        unique_visitors: 8,
        logged_in: 2,
        anonymous: 6,
        bots: 4,
        human_page_views: 6,
      },
    ]);

    const [row] = await dailyTraffic(7);
    expect(row.pageViews).toBe(10);
    expect(row.uniqueVisitors).toBe(8);
    expect(row.bots).toBe(4);
  });

  it("passes null through for all-time", async () => {
    query.mockResolvedValue([]);
    await dailyTraffic(null);
    expect(query.mock.calls[0][1]).toEqual([null]);
  });
});

describe("topPages", () => {
  it("groups by path and orders by views descending", async () => {
    query.mockResolvedValue([
      { path: "/", views: 40, unique_visitors: 30 },
      { path: "/stats", views: 12, unique_visitors: 10 },
    ]);

    const rows = await topPages(30);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/event_type = 'PAGE_VIEW'/);
    expect(sql).toMatch(/GROUP BY details->>'path'/);
    expect(sql).toMatch(/ORDER BY views DESC/);
    expect(params).toEqual([30]);

    expect(rows).toEqual([
      { path: "/", views: 40, uniqueVisitors: 30 },
      { path: "/stats", views: 12, uniqueVisitors: 10 },
    ]);
  });
});
