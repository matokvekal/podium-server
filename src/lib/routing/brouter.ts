// BRouter (https://github.com/abrensch/brouter, MIT) — bike routing on OpenStreetMap data.
//
// One GET per segment: /brouter?lonlats=lng,lat|lng,lat&profile=…&format=geojson. The answer is
// a FeatureCollection whose single LineString carries [lng, lat, ele] per point and a
// "track-length" property in metres.
//
// BRouter reports "no route" as a plain-text 400 ("from-position not mapped in existing
// datafile", "no track found", …). That is the rider's problem to solve (move the point, or
// draw it straight), so it becomes a 422 the client can explain. Anything else — timeout,
// 5xx, unreadable body — means the service is not there, which is a 503.

import { ApiError } from "../api-error.js";
import type { GeoPoint, RoutedSegment, RoutingProfile, RoutingProvider } from "./provider.js";

export const NO_ROUTE_MESSAGE = "No bike route between these points";
export const ROUTING_UNAVAILABLE_MESSAGE = "Routing is unavailable right now";

const TIMEOUT_MS = 10_000;

export interface BrouterOptions {
  baseUrl: string;
  profiles: Record<RoutingProfile, string>;
  fetchImpl?: typeof fetch;
}

/** 6 decimals is ~0.1 m — finer than any tap, and keeps the URL (and the cache key) stable. */
const coord = (n: number) => n.toFixed(6);

export function brouterUrl(
  baseUrl: string,
  from: GeoPoint,
  to: GeoPoint,
  profileName: string,
): string {
  const lonlats = `${coord(from.lng)},${coord(from.lat)}|${coord(to.lng)},${coord(to.lat)}`;
  const params = new URLSearchParams({
    lonlats,
    profile: profileName,
    alternativeidx: "0",
    format: "geojson",
  });
  return `${baseUrl}/brouter?${params.toString()}`;
}

/** Reads BRouter's GeoJSON; throws a 503 for any shape it does not recognise. */
export function parseBrouterGeojson(body: unknown): RoutedSegment {
  const feature = (body as { features?: unknown[] } | null)?.features?.[0] as
    | { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }
    | undefined;
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);
  }

  const points: RoutedSegment["points"] = [];
  for (const c of coordinates) {
    if (!Array.isArray(c)) continue;
    const [lng, lat, ele] = c as unknown[];
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push([lat, lng, typeof ele === "number" && Number.isFinite(ele) ? ele : null]);
  }
  if (points.length < 2) throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);

  const distanceM = Number(feature?.properties?.["track-length"]);
  return { points, distanceM: Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : 0 };
}

export function isBrouterNoRoute(status: number, text: string): boolean {
  if (status !== 400) return false;
  return /not mapped|no track found|target island|unable to reach|position not/i.test(text);
}

export class BrouterProvider implements RoutingProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BrouterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async calculateSegment(
    from: GeoPoint,
    to: GeoPoint,
    profile: RoutingProfile,
    signal?: AbortSignal,
  ): Promise<RoutedSegment> {
    const url = brouterUrl(this.options.baseUrl, from, to, this.options.profiles[profile]);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: "application/geo+json, application/json" },
      });
    } catch {
      throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (isBrouterNoRoute(response.status, text)) throw new ApiError(422, NO_ROUTE_MESSAGE);
      throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(503, ROUTING_UNAVAILABLE_MESSAGE);
    }
    return parseBrouterGeojson(body);
  }
}
