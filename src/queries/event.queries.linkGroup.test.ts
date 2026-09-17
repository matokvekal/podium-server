// The link-group query layer (sql/037) — one column, three functions, four properties.
//
//   1. IT DEGRADES ON A DATABASE WITHOUT sql/037. A 42703 means "the migration has not run",
//      not "something broke": the write warns and reports false so the service can answer
//      honestly, and the read answers [] because a database with no such column has no groups.
//   2. THE SQL IS PARAMETERIZED. `WHERE id = ANY($1::uuid[])` with the ids as a value —
//      never a list interpolated into the statement.
//   3. RELEASE BEFORE ASSIGN, IN ONE TRANSACTION. A ride moving between groups must not be
//      stamped and then cleared.
//   4. ⚠ EVERY EVENT READ STAYS `SELECT *` / `SELECT e.*`. That is the entire reason no
//      42703 risk exists on the list surfaces, and the reason link_group_id needs no entry in
//      EVENT_SUMMARY_COLUMNS. Anyone "optimising" those reads into an explicit column list
//      would silently drop the column and take the feature down with no error anywhere.
//
// No test database: ../db/pool.js is stubbed and the assertions are on what was asked of it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();
const withTransaction = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args),
}));

const {
  applyEventLinkGroup,
  selectEventsByLinkGroup,
  selectEventsByCodes,
  selectEventsForUser,
  selectPublicEvents,
  markParticipantLeft,
} = await import("./event.queries.js");

/** Postgres undefined_column — what a database without sql/037 answers. */
function missingColumn() {
  return Object.assign(new Error('column "link_group_id" of relation "events" does not exist'), {
    code: "42703",
  });
}

/** Runs the callback against a recording Transaction, the way the real withTransaction does. */
function runTransaction(calls: { text: string; params: unknown[] }[]) {
  return async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, params: unknown[]) => {
        calls.push({ text, params });
        return [];
      },
      queryOne: async () => null,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyEventLinkGroup", () => {
  it("releases before it assigns, inside one transaction", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    withTransaction.mockImplementation(runTransaction(calls));

    const written = await applyEventLinkGroup({
      clearIds: ["gravel"],
      assignIds: ["long", "short"],
      linkGroupId: "g1",
    });

    expect(written).toBe(true);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain("link_group_id = NULL");
    expect(calls[1].text).toContain("link_group_id = $2");
  });

  it("parameterizes the id list rather than interpolating it", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    withTransaction.mockImplementation(runTransaction(calls));

    await applyEventLinkGroup({ clearIds: [], assignIds: ["a", "b"], linkGroupId: "g1" });

    expect(calls[0].text).toContain("ANY($1::uuid[])");
    expect(calls[0].params).toEqual([["a", "b"], "g1"]);
    // Nothing that looks like a value spliced into the statement.
    expect(calls[0].text).not.toContain("'a'");
  });

  it("skips the release statement entirely when nothing is being released", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    withTransaction.mockImplementation(runTransaction(calls));

    await applyEventLinkGroup({ clearIds: [], assignIds: ["a"], linkGroupId: "g1" });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("link_group_id = $2");
  });

  it("writes nothing at all when both lists are empty", async () => {
    await expect(
      applyEventLinkGroup({ clearIds: [], assignIds: [], linkGroupId: "g1" }),
    ).resolves.toBe(true);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("degrades on a database without sql/037: warns, writes nothing, reports false", async () => {
    withTransaction.mockRejectedValue(missingColumn());

    await expect(
      applyEventLinkGroup({ clearIds: [], assignIds: ["a"], linkGroupId: "g1" }),
    ).resolves.toBe(false);
  });

  it("rethrows anything that is not a missing column", async () => {
    withTransaction.mockRejectedValue(Object.assign(new Error("deadlock"), { code: "40P01" }));

    await expect(
      applyEventLinkGroup({ clearIds: [], assignIds: ["a"], linkGroupId: "g1" }),
    ).rejects.toThrow("deadlock");
  });
});

describe("selectEventsByLinkGroup", () => {
  it("reads the whole group with SELECT *, ordered by start time", async () => {
    query.mockResolvedValue([]);
    await selectEventsByLinkGroup("g1");

    const [text, params] = query.mock.calls[0];
    expect(text).toContain("SELECT * FROM events");
    expect(text).toContain("WHERE link_group_id = $1");
    expect(text).toContain("ORDER BY starts_at ASC NULLS LAST");
    expect(params).toEqual(["g1"]);
  });

  it("answers [] on a database without sql/037 — no column means no groups", async () => {
    query.mockRejectedValue(missingColumn());
    await expect(selectEventsByLinkGroup("g1")).resolves.toEqual([]);
  });
});

describe("selectEventsByCodes", () => {
  it("resolves every code in one round trip", async () => {
    query.mockResolvedValue([]);
    await selectEventsByCodes(["19092026A", "19092026B"]);

    const [text, params] = query.mock.calls[0];
    expect(text).toContain("WHERE code = ANY($1)");
    expect(params).toEqual([["19092026A", "19092026B"]]);
  });

  it("does NOT filter on is_active — a share link is read long after the ride", async () => {
    query.mockResolvedValue([]);
    await selectEventsByCodes(["19092026A"]);
    expect(query.mock.calls[0][0]).not.toContain("is_active");
  });

  it("asks nothing for an empty code list", async () => {
    await expect(selectEventsByCodes([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("⚠ the guarantee that makes link_group_id safe before the migration", () => {
  it("selectEventsForUser still selects e.*, so a new events column needs no query change", async () => {
    query.mockResolvedValue([]);
    await selectEventsForUser(7);
    // "SELECT DISTINCT e.*" today — the assertion is on the whole-row select, not the wording.
    expect(query.mock.calls[0][0]).toMatch(/SELECT\s+(DISTINCT\s+)?e\.\*/);
  });

  it("and so does the public list, which is the surface a dropped column would take down", async () => {
    query.mockResolvedValue([]);
    queryOne.mockResolvedValue({ total: 0 });
    await selectPublicEvents({ bucket: "upcoming", sort: "soonest", limit: 1, offset: 0 });
    const selects = query.mock.calls.map((call) => call[0] as string);
    expect(selects.some((text) => /SELECT\s+(DISTINCT\s+)?e\.\*/.test(text))).toBe(true);
  });
});

describe("markParticipantLeft", () => {
  it("is scoped by user as well as by id, and only affects a row still on the list", async () => {
    execute.mockResolvedValue(1);
    await markParticipantLeft(42, 5);

    const [text, params] = execute.mock.calls[0];
    expect(text).toContain("SET left_at = NOW()");
    expect(text).toContain("WHERE id = $1 AND user_id = $2 AND left_at IS NULL");
    expect(params).toEqual([42, 5]);
  });

  it("does not touch registration_status — leaving is not being rejected", async () => {
    execute.mockResolvedValue(1);
    await markParticipantLeft(42, 5);
    expect(execute.mock.calls[0][0]).not.toContain("registration_status");
  });

  it("reports false when the rider had already left", async () => {
    execute.mockResolvedValue(0);
    await expect(markParticipantLeft(42, 5)).resolves.toBe(false);
  });
});
