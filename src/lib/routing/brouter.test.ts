import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error.js";
import {
  BrouterProvider,
  brouterUrl,
  isBrouterNoRoute,
  NO_ROUTE_MESSAGE,
  parseBrouterGeojson,
  ROUTING_UNAVAILABLE_MESSAGE,
} from "./brouter.js";
import { CachedRoutingProvider, segmentCacheKey } from "./cache.js";
import type { RoutingProvider } from "./provider.js";

// The shape brouter.de returned on 2026-10-19 for Pedaya -> south, trimmed to three points.
const GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { creator: "BRouter-1.7.11-beta", "track-length": "9343", "filtered ascend": "154" },
      geometry: {
        type: "LineString",
        coordinates: [
          [34.948937, 31.849892, 173.0],
          [34.948928, 31.849822, 173.25],
          [34.98, 31.8],
        ],
      },
    },
  ],
};

const PEDAYA = { lat: 31.85, lng: 34.95 };
const SOUTH = { lat: 31.8, lng: 34.98 };
const PROFILES = { road: "fastbike", mtb: "mtb" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("brouterUrl", () => {
  it("puts lng before lat, as BRouter expects", () => {
    const url = new URL(brouterUrl("https://brouter.example", PEDAYA, SOUTH, "fastbike"));
    expect(url.pathname).toBe("/brouter");
    expect(url.searchParams.get("lonlats")).toBe("34.950000,31.850000|34.980000,31.800000");
    expect(url.searchParams.get("profile")).toBe("fastbike");
    expect(url.searchParams.get("format")).toBe("geojson");
  });
});

describe("parseBrouterGeojson", () => {
  it("turns [lng, lat, ele] into [lat, lng, ele] and reads track-length", () => {
    const segment = parseBrouterGeojson(GEOJSON);
    expect(segment.distanceM).toBe(9343);
    expect(segment.points[0]).toEqual([31.849892, 34.948937, 173]);
    // A point with no elevation keeps its place with a null, not a made-up number.
    expect(segment.points[2]).toEqual([31.8, 34.98, null]);
  });

  it("refuses a body with no usable line", () => {
    expect(() => parseBrouterGeojson({ features: [] })).toThrow(ROUTING_UNAVAILABLE_MESSAGE);
    expect(() => parseBrouterGeojson(null)).toThrow(ApiError);
  });
});

describe("isBrouterNoRoute", () => {
  it("recognises BRouter's no-route texts only on a 400", () => {
    expect(isBrouterNoRoute(400, "from-position not mapped in existing datafile")).toBe(true);
    expect(isBrouterNoRoute(400, "no track found at pass=0")).toBe(true);
    expect(isBrouterNoRoute(500, "from-position not mapped")).toBe(false);
    expect(isBrouterNoRoute(400, "operation killed by thread-priority-watchdog")).toBe(false);
  });
});

describe("BrouterProvider", () => {
  it("returns the parsed segment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GEOJSON));
    const provider = new BrouterProvider({ baseUrl: "https://b", profiles: PROFILES, fetchImpl });
    const segment = await provider.calculateSegment(PEDAYA, SOUTH, "mtb");
    expect(segment.points).toHaveLength(3);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("profile=mtb");
  });

  it("sends each mode's own BRouter profile: Road = fastbike, Off-road = mtb", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(GEOJSON));
    const provider = new BrouterProvider({ baseUrl: "https://b", profiles: PROFILES, fetchImpl });
    await provider.calculateSegment(PEDAYA, SOUTH, "road");
    await provider.calculateSegment(PEDAYA, SOUTH, "mtb");
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("profile")).toBe("fastbike");
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("profile")).toBe("mtb");
  });

  it("maps a no-route 400 to a 422", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("from-position not mapped in existing datafile", { status: 400 }));
    const provider = new BrouterProvider({ baseUrl: "https://b", profiles: PROFILES, fetchImpl });
    await expect(provider.calculateSegment(PEDAYA, SOUTH, "road")).rejects.toMatchObject({
      status: 422,
      message: NO_ROUTE_MESSAGE,
    });
  });

  it("maps a 500, a network failure and a non-JSON body to a 503", async () => {
    for (const fetchImpl of [
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })),
    ]) {
      const provider = new BrouterProvider({ baseUrl: "https://b", profiles: PROFILES, fetchImpl });
      await expect(provider.calculateSegment(PEDAYA, SOUTH, "road")).rejects.toMatchObject({
        status: 503,
      });
    }
  });
});

describe("CachedRoutingProvider", () => {
  const answer = { points: [[1, 2, null] as [number, number, null]], distanceM: 5 };

  it("answers a repeat from the cache and keys on profile", async () => {
    const inner: RoutingProvider = { calculateSegment: vi.fn().mockResolvedValue(answer) };
    const cached = new CachedRoutingProvider(inner);
    await cached.calculateSegment(PEDAYA, SOUTH, "road");
    await cached.calculateSegment(PEDAYA, SOUTH, "road");
    await cached.calculateSegment(PEDAYA, SOUTH, "mtb");
    expect(inner.calculateSegment).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const inner: RoutingProvider = {
      calculateSegment: vi.fn().mockRejectedValueOnce(new ApiError(503, "x")).mockResolvedValue(answer),
    };
    const cached = new CachedRoutingProvider(inner);
    await expect(cached.calculateSegment(PEDAYA, SOUTH, "road")).rejects.toThrow();
    await expect(cached.calculateSegment(PEDAYA, SOUTH, "road")).resolves.toBe(answer);
  });

  it("evicts the least recently used entry past its size", async () => {
    const inner: RoutingProvider = { calculateSegment: vi.fn().mockResolvedValue(answer) };
    const cached = new CachedRoutingProvider(inner, 2);
    const a = { lat: 1, lng: 1 };
    const b = { lat: 2, lng: 2 };
    const c = { lat: 3, lng: 3 };
    await cached.calculateSegment(a, a, "road");
    await cached.calculateSegment(b, b, "road");
    await cached.calculateSegment(a, a, "road"); // a is now the most recent
    await cached.calculateSegment(c, c, "road"); // evicts b
    await cached.calculateSegment(a, a, "road");
    expect(inner.calculateSegment).toHaveBeenCalledTimes(3);
    await cached.calculateSegment(b, b, "road");
    expect(inner.calculateSegment).toHaveBeenCalledTimes(4);
  });

  it("treats points within ~1 m as the same request", () => {
    expect(segmentCacheKey({ lat: 31.850001, lng: 34.95 }, SOUTH, "road")).toBe(
      segmentCacheKey(PEDAYA, SOUTH, "road"),
    );
  });
});
