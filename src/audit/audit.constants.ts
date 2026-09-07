// The analytics event catalogue. One string per meaningful business action — the same names
// the migration comment and the summary view speak (sql/031-analytics-events.sql).
//
// V1 tracks only actions that change business state. No LOGIN / PAGE_VIEW / SEARCH / clicks —
// those are UI noise and there is no client analytics in this system by design.

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
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
