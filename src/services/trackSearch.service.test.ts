// Cover for the optional ranking layer in front of track search. The promise it makes: a ranker
// can only ADD boosts to a search — with none registered, or one that fails, times out or
// returns garbage, the search is exactly the lexical one.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const {
  clearTrackSearchRankers,
  prepareTrackSearch,
  RANKER_TIMEOUT_MS,
  registerTrackSearchRanker,
} = await import("./trackSearch.service.js");
const { buildTrackSearch } = await import("../lib/track-search.js");

afterEach(() => {
  clearTrackSearchRankers();
  vi.useRealTimers();
});

describe("prepareTrackSearch", () => {
  it("is the lexical search alone when no ranker is registered (today)", async () => {
    expect(await prepareTrackSearch("יער צרעה")).toEqual(buildTrackSearch("יער צרעה"));
    expect(await prepareTrackSearch(undefined)).toBeNull();
  });

  it("does not call rankers for an empty search", async () => {
    const scoreRoutes = vi.fn();
    registerTrackSearchRanker({ name: "t", scoreRoutes });
    expect(await prepareTrackSearch("  ")).toBeNull();
    expect(scoreRoutes).not.toHaveBeenCalled();
  });

  it("adds a ranker's scores as boosts, best first, summed per route and capped at 1", async () => {
    registerTrackSearchRanker({
      name: "a",
      scoreRoutes: async () => [
        { routeId: 1, score: 0.3 },
        { routeId: 2, score: 0.8 },
      ],
    });
    registerTrackSearchRanker({
      name: "b",
      scoreRoutes: async () => [
        { routeId: 1, score: 0.4 },
        { routeId: 2, score: 0.9 },
      ],
    });
    const search = await prepareTrackSearch("נחל");
    expect(search?.groups).toEqual(buildTrackSearch("נחל")?.groups);
    expect(search?.boosts).toEqual([
      { routeId: 2, score: 1 },
      { routeId: 1, score: 0.7 },
    ]);
  });

  it("ignores a ranker that throws", async () => {
    registerTrackSearchRanker({
      name: "broken",
      scoreRoutes: async () => {
        throw new Error("model not loaded");
      },
    });
    expect(await prepareTrackSearch("נחל")).toEqual(buildTrackSearch("נחל"));
  });

  it("aborts and ignores a ranker past the time limit", async () => {
    vi.useFakeTimers();
    let aborted = false;
    registerTrackSearchRanker({
      name: "slow",
      scoreRoutes: (_q, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const pending = prepareTrackSearch("נחל");
    await vi.advanceTimersByTimeAsync(RANKER_TIMEOUT_MS + 1);
    expect(await pending).toEqual(buildTrackSearch("נחל"));
    expect(aborted).toBe(true);
  });

  it("drops malformed scores", async () => {
    registerTrackSearchRanker({
      name: "sloppy",
      scoreRoutes: async () =>
        [
          { routeId: 3, score: 0.5 },
          { routeId: "4", score: 0.5 },
          { routeId: 5, score: Number.NaN },
          { routeId: -1, score: 0.5 },
          null,
        ] as never,
    });
    expect((await prepareTrackSearch("נחל"))?.boosts).toEqual([{ routeId: 3, score: 0.5 }]);
  });
});
