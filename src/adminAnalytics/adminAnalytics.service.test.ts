import { beforeEach, describe, expect, it, vi } from "vitest";

const q = {
  countUsers: vi.fn(),
  countRideCreators: vi.fn(),
  countRides: vi.fn(),
  countCurrentRegistrations: vi.fn(),
  countHistoricalJoins: vi.fn(),
  countActiveCountries: vi.fn(),
  ridesByVisibility: vi.fn(),
  routeStats: vi.fn(),
  dailyActivity: vi.fn(),
  countriesBreakdown: vi.fn(),
  dailyTraffic: vi.fn(),
  topPages: vi.fn(),
};

vi.mock("./adminAnalytics.queries.js", () => q);

const { getAdminAnalytics } = await import("./adminAnalytics.service.js");

beforeEach(() => {
  q.countUsers.mockResolvedValue(1240);
  q.countRideCreators.mockResolvedValue(183);
  q.countRides.mockResolvedValue(486);
  q.countCurrentRegistrations.mockResolvedValue(2931);
  q.countHistoricalJoins.mockResolvedValue(4102);
  q.countActiveCountries.mockResolvedValue(3);
  q.ridesByVisibility.mockResolvedValue({ public: 300, registered: 120, private: 66 });
  q.routeStats.mockResolvedValue({ created: 210, fromGpx: 140, copies: 512, distinctCopiers: 73 });
  q.dailyActivity.mockResolvedValue([
    { date: "2026-09-07", newUsers: 8, newRides: 5, newParticipants: 24 },
    { date: "2026-09-06", newUsers: 4, newRides: 3, newParticipants: 15 },
  ]);
  q.countriesBreakdown.mockResolvedValue([
    { countryCode: "IL", users: 1100, rides: 430 },
    { countryCode: "SE", users: 48, rides: 36 },
  ]);
  q.dailyTraffic.mockResolvedValue([
    {
      date: "2026-09-07",
      pageViews: 60,
      uniqueVisitors: 40,
      loggedIn: 15,
      anonymous: 25,
      bots: 5,
      humanPageViews: 55,
    },
    {
      date: "2026-09-06",
      pageViews: 50,
      uniqueVisitors: 30,
      loggedIn: 10,
      anonymous: 20,
      bots: 3,
      humanPageViews: 47,
    },
  ]);
  q.topPages.mockResolvedValue([{ path: "/", views: 40, uniqueVisitors: 30 }]);
});

describe("getAdminAnalytics", () => {
  it("assembles every section from the query layer", async () => {
    const r = await getAdminAnalytics(30);

    expect(r.rangeDays).toBe(30);
    expect(r.totals).toEqual({
      users: 1240,
      rideCreators: 183,
      rides: 486,
      currentRegistrations: 2931,
      historicalJoins: 4102,
      countries: 3,
    });
    expect(r.rides).toEqual({ public: 300, registered: 120, private: 66 });
    expect(r.routes).toEqual({
      created: 210,
      fromGpx: 140,
      otherMethods: 70, // created - fromGpx, derived in the service
      copies: 512,
      distinctCopiers: 73,
    });
    expect(r.countries[0]).toEqual({ countryCode: "IL", users: 1100, rides: 430 });
    expect(typeof r.generatedAt).toBe("string");
    expect(r.traffic.daily).toEqual([
      {
        date: "2026-09-07",
        pageViews: 60,
        uniqueVisitors: 40,
        loggedIn: 15,
        anonymous: 25,
        bots: 5,
        humanPageViews: 55,
      },
      {
        date: "2026-09-06",
        pageViews: 50,
        uniqueVisitors: 30,
        loggedIn: 10,
        anonymous: 20,
        bots: 3,
        humanPageViews: 47,
      },
    ]);
    expect(r.traffic.topPages).toEqual([{ path: "/", views: 40, uniqueVisitors: 30 }]);
  });

  it("traffic.today is the row dated today, null when there is none", async () => {
    vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
    const withToday = await getAdminAnalytics(30);
    expect(withToday.traffic.today).toEqual({
      date: "2026-09-07",
      pageViews: 60,
      uniqueVisitors: 40,
      loggedIn: 15,
      anonymous: 25,
      bots: 5,
      humanPageViews: 55,
    });

    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    const withoutToday = await getAdminAnalytics(30);
    expect(withoutToday.traffic.today).toBeNull();

    vi.useRealTimers();
  });

  it("passes the range through to the traffic queries too", async () => {
    await getAdminAnalytics(90);
    expect(q.dailyTraffic).toHaveBeenCalledWith(90);
    expect(q.topPages).toHaveBeenCalledWith(90);
  });

  it("passes the range through (null = all time)", async () => {
    await getAdminAnalytics(null);
    expect(q.dailyActivity).toHaveBeenCalledWith(null);
  });

  it("daily rows are newest first — daily[0].date >= daily[1].date", async () => {
    const r = await getAdminAnalytics(7);
    expect(r.daily[0].date >= r.daily[1].date).toBe(true);
  });

  it("a fresh / empty database returns a valid all-zero response, not an error", async () => {
    for (const fn of [
      q.countUsers,
      q.countRideCreators,
      q.countRides,
      q.countCurrentRegistrations,
      q.countHistoricalJoins,
      q.countActiveCountries,
    ]) {
      fn.mockResolvedValue(0);
    }
    q.ridesByVisibility.mockResolvedValue({});
    q.routeStats.mockResolvedValue({ created: 0, fromGpx: 0, copies: 0, distinctCopiers: 0 });
    q.dailyActivity.mockResolvedValue([]);
    q.countriesBreakdown.mockResolvedValue([]);
    q.dailyTraffic.mockResolvedValue([]);
    q.topPages.mockResolvedValue([]);

    const r = await getAdminAnalytics(30);

    expect(r.totals).toEqual({
      users: 0,
      rideCreators: 0,
      rides: 0,
      currentRegistrations: 0,
      historicalJoins: 0,
      countries: 0,
    });
    expect(r.rides).toEqual({ public: 0, registered: 0, private: 0 });
    expect(r.routes).toEqual({
      created: 0,
      fromGpx: 0,
      otherMethods: 0,
      copies: 0,
      distinctCopiers: 0,
    });
    expect(r.daily).toEqual([]);
    expect(r.countries).toEqual([]);
    expect(r.traffic).toEqual({ today: null, daily: [], topPages: [] });
  });

  it("missing visibility buckets read as 0, not undefined", async () => {
    q.ridesByVisibility.mockResolvedValue({ public: 10 });
    const r = await getAdminAnalytics(30);
    expect(r.rides).toEqual({ public: 10, registered: 0, private: 0 });
  });
});
