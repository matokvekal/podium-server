// Cover for routes.ai_search_text's content (sql/057): which ride fields go in, how they read,
// and — the property that matters most over time — that the same fact is never added twice no
// matter how many rides run on one track.

import { describe, expect, it } from "vitest";
import {
  type EventSearchSource,
  eventFragments,
  isEventEligibleForRouteText,
  MAX_FRAGMENT_CHARS,
  MAX_SEARCH_TEXT_CHARS,
  mergeSearchText,
  routeFragments,
} from "./route-search-text.js";

function event(overrides: Partial<EventSearchSource> = {}): EventSearchSource {
  return {
    name: null,
    description: null,
    location: null,
    area: null,
    region: null,
    country: null,
    activity_type: null,
    level: null,
    route_difficulty: null,
    season: null,
    shade: null,
    terrain_grade: null,
    is_accessible: null,
    ...overrides,
  };
}

describe("eventFragments", () => {
  it("labels every track-related field in words, description last", () => {
    const lines = eventFragments(
      event({
        name: "Ben Shemen forest loop",
        description: "Flowy singletrack,\n\n  one steep climb.",
        location: "Ben Shemen",
        area: "Modiin",
        region: "center",
        country: "IL",
        activity_type: "mtb",
        level: "intermediate",
        route_difficulty: "moderate",
        season: "winter_spring",
        shade: "partial",
        terrain_grade: 2,
        is_accessible: true,
      }),
    ).map((f) => `${f.label}: ${f.value}`);

    expect(lines).toEqual([
      "Ride: Ben Shemen forest loop",
      "Location: Ben Shemen",
      "Area: Modiin",
      "Region: Center / מרכז",
      "Country: IL",
      "Activity: mountain bike (MTB)",
      "Difficulty: moderate",
      "Rider level: intermediate",
      "Terrain grade: S2",
      "Season: winter and spring",
      "Shade: partly shaded",
      "Accessibility: accessible",
      "Description: Flowy singletrack, one steep climb.",
    ]);
  });

  it("uses G-grades for gravel and leaves out everything unset", () => {
    expect(eventFragments(event({ activity_type: "gravel", terrain_grade: 3 }))).toEqual([
      { label: "Activity", value: "gravel" },
      { label: "Terrain grade", value: "G3" },
    ]);
    expect(eventFragments(event({ name: "   ", is_accessible: false }))).toEqual([]);
  });

  it("caps one very long field", () => {
    const [desc] = eventFragments(event({ description: "x".repeat(5000) }));
    expect(desc.value.length).toBe(MAX_FRAGMENT_CHARS + 1); // + the ellipsis
  });
});

describe("routeFragments", () => {
  it("takes the route's own name, place and surface", () => {
    expect(routeFragments({ name: "Latrun", place_name: "Latrun", route_type: "mixed" })).toEqual([
      { label: "Track", value: "Latrun" },
      { label: "Place", value: "Latrun" },
      { label: "Surface", value: "mixed surface" },
    ]);
  });
});

describe("mergeSearchText", () => {
  it("starts an empty route's text", () => {
    expect(
      mergeSearchText(null, [
        { label: "Ride", value: "Latrun loop" },
        { label: "Season", value: "all year" },
      ]),
    ).toBe("Ride: Latrun loop\nSeason: all year");
  });

  it("returns null when the ride adds nothing new — the route row is left untouched", () => {
    expect(
      mergeSearchText("Region: Center / מרכז", [{ label: "Region", value: "center / מרכז" }]),
    ).toBe(null);
  });

  it("does not repeat a value already present under another label or inside a longer value", () => {
    const out = mergeSearchText(null, [
      { label: "Ride", value: "Modiin forest loop" },
      { label: "Location", value: "Modiin" },
      { label: "Place", value: "MODIIN   forest" },
    ]);
    expect(out).toBe("Ride: Modiin forest loop");
  });

  it("matches whole words only — S2 is not already there because S25 is", () => {
    expect(mergeSearchText("Ride: Route S25", [{ label: "Terrain grade", value: "S2" }])).toBe(
      "Ride: Route S25\nTerrain grade: S2",
    );
  });

  it("deduplicates Hebrew too", () => {
    expect(mergeSearchText("Ride: סינגל בן שמן", [{ label: "Location", value: "בן שמן" }])).toBe(
      null,
    );
  });

  it("ten rides with the same facts add them once", () => {
    let text: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      text =
        mergeSearchText(text, [
          { label: "Region", value: "Center / מרכז" },
          { label: "Season", value: "all year" },
        ]) ?? text;
    }
    expect(text).toBe("Region: Center / מרכז\nSeason: all year");
  });

  it("keeps a different ride's new facts", () => {
    expect(
      mergeSearchText("Ride: Latrun loop\nSeason: all year", [
        { label: "Ride", value: "Latrun sunrise" },
        { label: "Season", value: "all year" },
      ]),
    ).toBe("Ride: Latrun loop\nSeason: all year\nRide: Latrun sunrise");
  });

  it("never grows past the cap", () => {
    const big = "y".repeat(MAX_SEARCH_TEXT_CHARS - 10);
    expect(mergeSearchText(big, [{ label: "Ride", value: "one more ride name" }])).toBe(null);
  });
});

describe("isEventEligibleForRouteText", () => {
  it("only publicly listed rides contribute", () => {
    expect(isEventEligibleForRouteText({ visibility: "public", status: "published" })).toBe(true);
    expect(isEventEligibleForRouteText({ visibility: "public", status: "finished" })).toBe(true);
    expect(isEventEligibleForRouteText({ visibility: "private", status: "published" })).toBe(false);
    expect(isEventEligibleForRouteText({ visibility: "registered", status: "published" })).toBe(
      false,
    );
    expect(isEventEligibleForRouteText({ visibility: "public", status: "draft" })).toBe(false);
    expect(isEventEligibleForRouteText({ visibility: "public", status: "cancelled" })).toBe(false);
  });
});
