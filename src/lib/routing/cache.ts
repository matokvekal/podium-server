// A small in-memory LRU in front of the routing provider.
//
// Undo, redo and dragging a point back to where it was all ask for a segment the server has
// already answered — this keeps those off the routing service entirely. Per process, lost on
// restart, and that is fine: it is a courtesy to the provider, not a store.

import type { GeoPoint, RoutedSegment, RoutingProfile, RoutingProvider } from "./provider.js";

const MAX_ENTRIES = 2000;

/** 5 decimals is ~1 m — two taps that close are the same request. */
export function segmentCacheKey(from: GeoPoint, to: GeoPoint, profile: RoutingProfile): string {
  const c = (n: number) => n.toFixed(5);
  return `${profile}:${c(from.lat)},${c(from.lng)}:${c(to.lat)},${c(to.lng)}`;
}

export class CachedRoutingProvider implements RoutingProvider {
  private readonly entries = new Map<string, RoutedSegment>();

  constructor(
    private readonly inner: RoutingProvider,
    private readonly maxEntries = MAX_ENTRIES,
  ) {}

  async calculateSegment(
    from: GeoPoint,
    to: GeoPoint,
    profile: RoutingProfile,
    signal?: AbortSignal,
  ): Promise<RoutedSegment> {
    const key = segmentCacheKey(from, to, profile);
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert so Map order tracks recency: the first key is always the least recent.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }

    // Failures are not cached: "no route" may be a timeout on a busy server, and a retry
    // should actually retry.
    const segment = await this.inner.calculateSegment(from, to, profile, signal);
    this.entries.set(key, segment);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return segment;
  }
}
