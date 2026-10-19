// The Route Builder's routing seam.
//
// The builder only ever asks for ONE segment at a time — from one waypoint to the next — so a
// dragged waypoint re-routes its two neighbours and nothing else, and every answer is cacheable
// on its own. A provider turns that request into a bike line; brouter.ts is the only one today,
// and a GraphHopper or Valhalla provider would be one more file implementing this interface.

export const ROUTING_PROFILES = ["road", "mtb"] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RoutedSegment {
  /** [lat, lng, ele] — ele is null where the provider had no elevation for that point. */
  points: [number, number, number | null][];
  distanceM: number;
}

export interface RoutingProvider {
  calculateSegment(
    from: GeoPoint,
    to: GeoPoint,
    profile: RoutingProfile,
    signal?: AbortSignal,
  ): Promise<RoutedSegment>;
}
