// Cover for free-text search in selectPublicEvents (lib/track-search.ts → SQL).
//
// No test database, so ../db/pool.js is stubbed and these pin down the statement's SHAPE: the
// search join appears only for a search, every word must match, ranking only replaces the
// default order, filters and paging are untouched, the COUNT can bind every parameter, a
// database without pg_trgm still searches, and optional ranking boosts only ever reach ORDER BY.
// What the SQL actually finds on real data was checked read-only against production.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrackSearch } from "../lib/track-search.js";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { selectPublicEvents, TRACK_SEARCH_FUZZY_THRESHOLD } = await import("./event.queries.js");

const BASE = { limit: 24, offset: 0, uniqueTracks: true } as const;

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockResolvedValue({ count: "0" });
});

function listCall(): { sql: string; params: unknown[] } {
  const [sql, params] = query.mock.calls[0] as [string, unknown[]];
  return { sql, params };
}
function countCall(): { sql: string; params: unknown[] } {
  const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
  return { sql, params };
}
function spec(params: unknown[]): { phrase: string; groups: string[][]; boosts?: unknown } {
  const json = params.find((p) => typeof p === "string" && p.startsWith('{"phrase"'));
  return JSON.parse(json as string);
}
/** Every $n in `sql`, and the highest. */
function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

describe("selectPublicEvents — no search", () => {
  it("adds no search join and keeps the requested order", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest" });
    const { sql } = listCall();
    expect(sql).not.toMatch(/search_summary/);
    expect(sql).toMatch(/ORDER BY e\.created_at DESC, e\.id LIMIT/);
    expect(countCall().sql).not.toMatch(/search_summary/);
  });
});

describe("selectPublicEvents — search", () => {
  it("joins the route's name, place and ai_search_text into one searchable text", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "יער צרעה" });
    const { sql } = listCall();
    expect(sql).toMatch(/LEFT JOIN routes rs ON rs\.id = route_summary\.route_id/);
    expect(sql).toMatch(/rs\.ai_search_text\)\) AS doc/);
    // The COUNT has the same join, or its WHERE could not see search_summary.
    expect(countCall().sql).toMatch(/search_summary/);
  });

  it("binds one group per word — every word must match, in any order", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "צרעה יער" });
    const { sql, params } = listCall();
    expect(spec(params).groups).toEqual([["צרעה"], ["יער"]]);
    // "No group without a hit" = every word found.
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM jsonb_array_elements\(\(\$\d+::jsonb -> 'groups'\)\)/,
    );
  });

  it("matches partial words as substrings and typos by trigram similarity", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "צרעא" });
    const { sql, params } = listCall();
    expect(sql).toMatch(/strpos\(search_summary\.doc, alt\.tok\) > 0/);
    expect(sql).toMatch(/word_similarity\(alt\.tok, search_summary\.doc\) >= \$\d+::float8/);
    expect(params).toContain(TRACK_SEARCH_FUZZY_THRESHOLD);
  });

  it("still finds a ride by its code or id", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "06092026A" });
    const { sql, params } = listCall();
    expect(sql).toMatch(/e\.code ILIKE \$1/);
    expect(sql).toMatch(/e\.id::text = \$1/);
    expect(params[0]).toBe("06092026A");
  });

  it("ranks by relevance under the default order, strongest signal first", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "jerusalem gravel" });
    const { sql } = listCall();
    const order = sql.slice(sql.lastIndexOf("ORDER BY"));
    expect(order).toMatch(/^ORDER BY \(CASE\s+WHEN search_summary\.route_name = /);
    expect(order).toMatch(/THEN 100/);
    expect(order).toMatch(/\+ 20 \* .*search_summary\.names/s);
    expect(order).toMatch(/\+ 10 \* .*search_summary\.places/s);
    expect(order).toMatch(/\+ 5 \* .*search_summary\.doc/s);
    expect(order).toMatch(/\+ 10 \* word_similarity/);
    expect(order).toMatch(/DESC, e\.created_at DESC, e\.id LIMIT/);
  });

  it("keeps an order the rider picked", async () => {
    await selectPublicEvents({ ...BASE, sort: "distance_asc", q: "נחל" });
    expect(listCall().sql).toMatch(
      /ORDER BY route_summary\.distance_km ASC NULLS LAST, e\.created_at DESC, e\.id LIMIT/,
    );
  });

  it("keeps the structured filters as SQL filters alongside the search", async () => {
    await selectPublicEvents({
      ...BASE,
      sort: "newest",
      q: "נחל",
      activityType: ["mtb"],
      region: "upper_galilee",
      minDistanceKm: 30,
      maxDistanceKm: 50,
      routeDifficulty: ["easy"],
    });
    const { sql, params } = listCall();
    expect(sql).toMatch(/e\.activity_type = ANY\(\$3::text\[\]\)/);
    expect(sql).toMatch(/e\.region = \$13/);
    expect(sql).toMatch(/route_summary\.distance_km >= \$7/);
    expect(sql).toMatch(/e\.route_difficulty = ANY\(\$\d+::text\[\]\)/);
    expect(params[2]).toEqual(["mtb"]);
    expect(params[12]).toBe("upper_galilee");
    // Still one row per track — the dedup clause is untouched.
    expect(sql).toMatch(/\$14::boolean IS NOT TRUE OR NOT EXISTS/);
  });

  it("binds exactly the parameters each statement uses — the COUNT included (42P18)", async () => {
    await selectPublicEvents({
      ...BASE,
      sort: "newest",
      q: "ירושלים שטח",
      season: ["winter_spring"],
      routeId: 5,
      // Near Me binds $17-$19; the search's own parameters must come after them.
      nearLat: 31.78,
      nearLon: 35.22,
      nearRadiusKm: 20,
    });
    const list = listCall();
    const count = countCall();
    // The list binds limit + offset on top of the count's parameters.
    expect(placeholders(list.sql)).toEqual(list.params.map((_, i) => i + 1));
    expect(placeholders(count.sql)).toEqual(count.params.map((_, i) => i + 1));
  });

  it("falls back to typo-free search on a database without pg_trgm", async () => {
    query
      .mockRejectedValueOnce(
        Object.assign(new Error("function word_similarity(text, text) does not exist"), {
          code: "42883",
        }),
      )
      .mockResolvedValue([]);

    await selectPublicEvents({ ...BASE, sort: "newest", q: "צרעה" });

    const [retrySql] = query.mock.calls[1] as [string];
    expect(retrySql).toMatch(/search_summary/);
    expect(retrySql).not.toMatch(/word_similarity/);
  });

  it("keeps plain substring search for input with nothing to tokenize", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "!!" });
    const { sql } = listCall();
    expect(sql).not.toMatch(/search_summary/);
    expect(sql).toMatch(/e\.name ILIKE '%' \|\| \$1 \|\| '%'/);
  });
});

describe("selectPublicEvents — optional ranking boosts", () => {
  it("leave the statement unchanged when there are none", async () => {
    await selectPublicEvents({ ...BASE, sort: "newest", q: "נחל" });
    const without = listCall().sql;
    query.mockClear();
    await selectPublicEvents({
      ...BASE,
      sort: "newest",
      q: "נחל",
      search: buildTrackSearch("נחל"),
    });
    expect(listCall().sql).toBe(without);
    expect(without).not.toMatch(/boosts/);
  });

  it("only add to the ORDER BY — never to what matches", async () => {
    const search = { ...buildTrackSearch("נחל")!, boosts: [{ routeId: 42, score: 0.9 }] };
    await selectPublicEvents({ ...BASE, sort: "newest", q: "נחל", search });
    const { sql, params } = listCall();
    const where = sql.slice(sql.indexOf("WHERE e.visibility"), sql.lastIndexOf("ORDER BY"));
    const order = sql.slice(sql.lastIndexOf("ORDER BY"));
    expect(where).not.toMatch(/boosts/);
    expect(order).toMatch(
      /\+ 40 \* COALESCE\(\(\s*SELECT LEAST\(GREATEST\(\(b->>'score'\)::float8, 0\), 1\)/,
    );
    expect(spec(params).boosts).toEqual([{ routeId: 42, score: 0.9 }]);
    // The COUNT never sees them.
    expect(countCall().sql).not.toMatch(/boosts/);
  });

  it("are ignored under an order the rider picked", async () => {
    const search = { ...buildTrackSearch("נחל")!, boosts: [{ routeId: 42, score: 0.9 }] };
    await selectPublicEvents({ ...BASE, sort: "likes_desc", q: "נחל", search });
    expect(listCall().sql.slice(listCall().sql.lastIndexOf("ORDER BY"))).not.toMatch(/boosts/);
  });
});
