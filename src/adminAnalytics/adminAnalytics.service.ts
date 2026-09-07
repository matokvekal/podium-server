// Assembles the one /admin2026 response from the query layer. No business logic beyond
// "run the reads, shape the object" — the spec wants this dead simple.

import {
  countActiveCountries,
  countCurrentRegistrations,
  countHistoricalJoins,
  countRideCreators,
  countRides,
  countriesBreakdown,
  countUsers,
  dailyActivity,
  ridesByVisibility,
  routeStats,
} from "./adminAnalytics.queries.js";
import type { AnalyticsRange, AnalyticsResponse } from "./adminAnalytics.types.js";

export async function getAdminAnalytics(range: AnalyticsRange): Promise<AnalyticsResponse> {
  const [
    users,
    rideCreators,
    rides,
    currentRegistrations,
    historicalJoins,
    countries,
    visibility,
    routes,
    daily,
    countryRows,
  ] = await Promise.all([
    countUsers(),
    countRideCreators(),
    countRides(),
    countCurrentRegistrations(),
    countHistoricalJoins(),
    countActiveCountries(),
    ridesByVisibility(),
    routeStats(),
    dailyActivity(range),
    countriesBreakdown(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    rangeDays: range,
    totals: { users, rideCreators, rides, currentRegistrations, historicalJoins, countries },
    rides: {
      public: visibility.public ?? 0,
      registered: visibility.registered ?? 0,
      private: visibility.private ?? 0,
    },
    routes: {
      created: routes.created,
      fromGpx: routes.fromGpx,
      otherMethods: routes.created - routes.fromGpx,
      copies: routes.copies,
      distinctCopiers: routes.distinctCopiers,
    },
    daily,
    countries: countryRows,
  };
}
