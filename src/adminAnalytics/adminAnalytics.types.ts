// The one response GET /api/v1/admin/analytics returns. Kept flat and small — the /admin2026
// page renders it almost verbatim.

/** null = "All time"; a number = the last N days (the `daily` array and the "new in range"
 *  counters are clipped to it; the top totals are always all-time). */
export type AnalyticsRange = 7 | 30 | 90 | null;

export interface DailyRow {
  /** YYYY-MM-DD (machine-friendly; the client formats for display). */
  date: string;
  newUsers: number;
  newRides: number;
  newParticipants: number;
}

export interface CountryRow {
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: string;
  users: number;
  rides: number;
}

export interface AnalyticsResponse {
  generatedAt: string;
  /** Which range the `daily` rows cover. null = all time. */
  rangeDays: number | null;

  /** All-time totals — never clipped by the range (the spec: totals are TOTAL). */
  totals: {
    users: number;
    /** Distinct accounts that own at least one ride. */
    rideCreators: number;
    rides: number;
    /** People on a start list right now: registration_status in
     *  (registered, approved, waiting_approval) AND left_at IS NULL. */
    currentRegistrations: number;
    /** Every participant row ever written — the all-time "successful joins" figure. */
    historicalJoins: number;
    /** Distinct non-null events.country values. */
    countries: number;
  };

  /** Rides by visibility (all time). */
  rides: {
    public: number;
    registered: number;
    private: number;
  };

  /**
   * Routes (all time), straight from the `routes` and `route_copies` business tables so the
   * numbers cover the full history, not just the analytics window.
   *   created        every routes row
   *   fromGpx        routes.source = 'gpx'
   *   otherMethods   created - fromGpx  (drawn / csv-as-drawn / tcx / geojson / …)
   *   copies         every route_copies row — the reuse/copy metric (sql/025)
   *   distinctCopiers COUNT(DISTINCT copied_by_user_id)
   * `copies` / `distinctCopiers` are 0 if sql/025 has not been applied.
   */
  routes: {
    created: number;
    fromGpx: number;
    otherMethods: number;
    copies: number;
    distinctCopiers: number;
  };

  /** One row per day with any activity, in the range, NEWEST FIRST. */
  daily: DailyRow[];

  /** Users and rides per country (all time), most rides first. */
  countries: CountryRow[];
}
