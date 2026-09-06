// Cover for WHO CAN FIND A TRACK — the predicate behind GET /routes/public.
//
// `routes.is_public` is a SNAPSHOT, written once at insert from `event.visibility === "public"`
// (eventRoute.service.ts's setEventRouteFromPoints) and never re-synced. An organizer who took a
// public ride private therefore left its track sitting in the public library, readable in full
// and anonymously through GET /routes/:routeId. selectPublicRoutes now derives discoverability
// from the backing ride instead of trusting that snapshot, and these tests pin both halves of it.
//
// There is no test database in this repo, so ../db/pool.js is stubbed and the assertions are on
// the SQL text handed to it — the same harness routeCopy.queries.test.ts uses. That means these
// tests prove the STATEMENT is the intended one, not that Postgres agrees with our reading of it;
// the semantics are checked by hand against the docker database (npm run db:up).

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: vi.fn(),
}));

const { selectPublicRoutes } = await import("./routeLibrary.queries.js");

/** Both statements share one `where`, so every rule has to hold in both. */
async function whereClauses(): Promise<{ list: string; count: string }> {
  query.mockResolvedValue([]);
  queryOne.mockResolvedValue({ count: "0" });
  await selectPublicRoutes({ limit: 60, offset: 0 } as never);
  return {
    list: query.mock.calls[0][0] as string,
    count: queryOne.mock.calls[0][0] as string,
  };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
});

describe("selectPublicRoutes — a private ride's track is undiscoverable", () => {
  it("only lists a ride-backed track while a PUBLIC ride still backs it", async () => {
    const { list, count } = await whereClauses();

    for (const sql of [list, count]) {
      // The EXISTS is what makes PUBLIC -> PRIVATE take effect with no write and no backfill.
      expect(sql).toMatch(/EXISTS\s*\(/);
      expect(sql).toMatch(/JOIN events e ON e\.id = er\.event_id/);
      expect(sql).toMatch(/e\.visibility = 'public'/);
    }
  });

  it("does not count a cancelled or draft ride as making a track public", async () => {
    const { list, count } = await whereClauses();

    // A cancelled ride is not a published one, and a draft was never published at all —
    // neither may keep a track listed. Mirrors selectPublicEvents' own status rule.
    for (const sql of [list, count]) {
      expect(sql).toMatch(/e\.status NOT IN \('cancelled', 'draft'\)/);
    }
  });

  it("keeps is_public as the leading term, so PATCH { isPublic: false } still unlists", async () => {
    const { list, count } = await whereClauses();

    // Deriving from the ride ADDS a condition; it must never grant discoverability on its own,
    // or an owner's explicit "unpublish" would stop working.
    for (const sql of [list, count]) {
      expect(sql).toMatch(/r\.is_public = TRUE/);
    }
  });
});

describe("selectPublicRoutes — a library upload with no ride behind it survives", () => {
  it("keeps the NOT EXISTS arm for routes that have no event_routes row at all", async () => {
    const { list, count } = await whereClauses();

    // THE REGRESSION THIS FILE EXISTS FOR. A route uploaded straight to the library
    // (POST /routes) has no ride to derive from, so the EXISTS arm can never match it. Without
    // this second arm every such upload silently disappears from Find Tracks — and production
    // holds none of them today, so no live data would catch it.
    for (const sql of [list, count]) {
      expect(sql).toMatch(
        /NOT EXISTS\s*\(SELECT 1 FROM event_routes er WHERE er\.route_id = r\.id\)/,
      );
    }
  });
});

describe("selectPublicRoutes — the existing filters are untouched", () => {
  it("still applies place, distance, elevation and type, and still pages", async () => {
    query.mockResolvedValue([]);
    queryOne.mockResolvedValue({ count: "0" });

    await selectPublicRoutes({
      place: "Jerusalem",
      minDistance: 10,
      maxDistance: 90,
      minElevation: 100,
      maxElevation: 2000,
      type: "gravel",
      limit: 60,
      offset: 120,
    } as never);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];

    // The derived clause adds no placeholder, so the filters keep their numbers. If it ever
    // does take one, these are the assertions that catch the silent renumbering.
    expect(sql).toMatch(/\$1::text IS NULL OR r\.place_name ILIKE/);
    expect(sql).toMatch(/\$2::double precision IS NULL OR r\.distance_km >= \$2/);
    expect(sql).toMatch(/\$6::text IS NULL OR r\.route_type = \$6/);
    expect(sql).toMatch(/LIMIT \$7 OFFSET \$8/);
    expect(values).toEqual(["Jerusalem", 10, 90, 100, 2000, "gravel", 60, 120]);

    // The count runs the same predicate over the same six values, without limit/offset.
    expect(queryOne.mock.calls[0][1]).toEqual(["Jerusalem", 10, 90, 100, 2000, "gravel"]);
  });
});

describe("the read stays a read", () => {
  it("selectPublicRoutes writes nothing", async () => {
    await whereClauses();

    // Discoverability is DERIVED. If a future change tries to "fix up" is_public from here,
    // the browse endpoint starts writing on an anonymous GET — this is the guard.
    expect(execute).not.toHaveBeenCalled();
    for (const sql of [query.mock.calls[0][0], queryOne.mock.calls[0][0]] as string[]) {
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    }
  });
});
