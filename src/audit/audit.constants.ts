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
   * A genuinely new route was stored — a GPX/hand-drawn line attached to a ride
   * (eventRoute.service.ts::setEventRouteFromPoints) or POST /routes
   * (routeLibrary.service.ts::createRoute). NOT attaching an existing route to another ride
   * (that is ROUTE_COPIED).
   */
  "ROUTE_CREATED",
  /**
   * An existing route was reused on another ride — "copy the track from that ride" or picking
   * one from the library (eventRoute.service.ts::recordRouteCopy, the same path that writes a
   * route_copies row). Copying your own track does not count, exactly as route_copies does not.
   */
  "ROUTE_COPIED",
  /**
   * A route file was downloaded. RESERVED — there is no route-file / GPX-export endpoint on the
   * server today (the "Downloads" number in the UI is the route_copies count, i.e. ROUTE_COPIED).
   * Wire this when a real export endpoint is added.
   */
  "ROUTE_DOWNLOADED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
