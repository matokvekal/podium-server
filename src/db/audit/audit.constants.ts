// The analytics event catalogue. One string per meaningful business action — the same names
// the migration comment and the summary view speak (sql/031-analytics-events.sql).
//
// V1 tracked only actions that change business state — no LOGIN / PAGE_VIEW / SEARCH / clicks,
// deliberately, as UI noise. PAGE_VIEW below is the one reversal of that: a minimal, permanent
// site-traffic count for /admin2026 (daily visits, bot vs human), still through this same table
// and the same non-fatal trackAuditEvent() contract — see src/routes/analytics.routes.ts.

export const AUDIT_EVENT_TYPES = [
  /** A brand-new user row was created for a provider identity (auth.service.ts::resolveUser). */
  "USER_REGISTERED",
  /** A ride was created (event.service.ts::createEvent). */
  "RIDE_CREATED",
  /** A rider joined a ride with its code (event.service.ts::joinEvent). */
  "RIDE_JOINED",
  /**
   * A rider left a ride. RESERVED — there is no server-side self-leave flow today (the client
   * calls POST /events/:id/leave, which the server never implemented). Wire this the moment
   * that endpoint exists; until then no row of this type is ever written.
   */
  "RIDE_LEFT",
  /**
   * A genuinely new route row was stored. `details.source` carries the real
   * `routes.source` value (db/types.ts ROUTE_SOURCES = gpx | tcx | geojson | json | drawn |
   * copied):
   *   - routeLibrary.service.ts::createRoute (POST /routes)          -> whatever the client sent
   *   - eventRoute.service.ts::setEventRouteFromPoints (the create   -> always 'drawn': that
   *     form's GPX/CSV import + hand-drawn line share one endpoint       endpoint's body has no
   *     that has no source field, so routes.source is 'drawn' there)     source field
   * NOT attaching an existing route to another ride — that is ROUTE_COPIED.
   */
  "ROUTE_CREATED",
  /**
   * An existing route was reused/copied by another ride or user — "copy the track from that
   * ride" or picking one out of the library. eventRoute.service.ts::recordRouteCopy, the same
   * branch that writes a route_copies row (sql/025). Copying your OWN track does not count,
   * exactly as route_copies does not. This is the download/copy/reuse metric.
   */
  "ROUTE_COPIED",
  /**
   * A rider liked a track in Find Tracks (sql/036 route_likes). Recorded only on the insert
   * that actually counted — pressing an already-liked button is idempotent and silent, so this
   * is a real count of distinct (rider, track) likes and not of button presses. Favourites are
   * deliberately NOT tracked: they are a private bookmark, not an engagement signal.
   */
  "ROUTE_LIKED",
  /**
   * A real SPA route navigation (analytics.controller.ts), fired client-side on pathname
   * change and POSTed to /api/v1/analytics/page-view. `details` carries path/visitorId/
   * sessionId/referrer/isBot/deviceType — see src/schemas/analytics.schemas.ts. Excludes
   * /admin2026 itself, API calls, and static assets (those never go through this endpoint).
   */
  "PAGE_VIEW",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
