// Regression cover for the approve/reject SQL. This repo has no test database, so the DB
// layer (../db/pool.js) is stubbed and the assertions are on the SQL text + bound parameters
// that updateRegistrationStatus hands to Postgres.
//
// The bug this guards against: PostgreSQL 42P18 "could not determine data type of parameter
// $1". updateRegistrationStatus bound `participantId` as $1 in its (event_id, user_id) branch
// but never referenced $1 in the statement, so the parse step could not type it and every
// approve/reject of an app-joined rider 500'd.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { updateRegistrationStatus } = await import("./participant.queries.js");

const EVENT_ID = "1ccab6f1-b2f6-4ede-bd2d-face92179797";

function participantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    event_id: EVENT_ID,
    user_id: 42,
    bib: null,
    joined_at: new Date("2026-08-28T10:00:00Z"),
    left_at: null,
    name: null,
    email: null,
    phone: null,
    category: null,
    team: null,
    country_code: null,
    group_id: null,
    registration_status: "approved",
    attendance_status: "unknown",
    result_status: "none",
    finished_at: null,
    finish_position: null,
    display_name: "Rider Two",
    avatar_url: null,
    avatar_type: null,
    avatar_value: null,
    ...overrides,
  };
}

/**
 * The 42P18 invariant: every parameter bound in the values array MUST appear in the SQL. A
 * value passed for a placeholder the statement never names cannot be type-inferred by the
 * Postgres parser.
 */
function expectEveryBoundParamIsReferenced(sql: string, params: readonly unknown[]) {
  for (let i = 1; i <= params.length; i++) {
    expect(sql, `$${i} is bound but not referenced in the SQL`).toMatch(
      new RegExp(`\\$${i}(?!\\d)`),
    );
  }
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("updateRegistrationStatus — SQL / parameter contract", () => {
  it("app-joined rider (user_id set): binds only parameters the statement references", async () => {
    queryOne.mockResolvedValueOnce({ user_id: 42 }); // the id -> user_id lookup
    query.mockResolvedValueOnce([participantRow()]); // the UPDATE ... RETURNING

    await updateRegistrationStatus(2, EVENT_ID, "approved");

    // Both statements it issued must be self-consistent.
    for (const call of queryOne.mock.calls) {
      expectEveryBoundParamIsReferenced(call[0] as string, call[1] as unknown[]);
    }
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expectEveryBoundParamIsReferenced(sql, params);

    // The regression itself: participantId must NOT be smuggled in as an unreferenced param.
    expect(params).toEqual([EVENT_ID, "approved", 42]);
    expect(sql).toMatch(/WHERE\s+event_id = \$1 AND user_id = \$3/);
    expect(sql).toMatch(/SET registration_status = \$2/);
    expect(sql).not.toContain("$4");
  });

  it("manual-add rider (user_id null): matches on the row id, all three params referenced", async () => {
    queryOne.mockResolvedValueOnce({ user_id: null });
    query.mockResolvedValueOnce([participantRow({ id: 7, user_id: null, display_name: null, name: "Walk-in" })]);

    await updateRegistrationStatus(7, EVENT_ID, "rejected");

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expectEveryBoundParamIsReferenced(sql, params);
    expect(params).toEqual([7, EVENT_ID, "rejected"]);
    expect(sql).toMatch(/WHERE id = \$1 AND event_id = \$2/);
    expect(sql).toMatch(/SET registration_status = \$3/);
  });

  it("returns the mapped row for approve", async () => {
    queryOne.mockResolvedValueOnce({ user_id: 42 });
    query.mockResolvedValueOnce([participantRow({ registration_status: "approved" })]);

    const result = await updateRegistrationStatus(2, EVENT_ID, "approved");
    expect(result).toMatchObject({ id: 2, eventId: EVENT_ID, registrationStatus: "approved", name: "Rider Two" });
  });

  it("returns null when the participant/event pair does not exist", async () => {
    queryOne.mockResolvedValueOnce(null);
    const result = await updateRegistrationStatus(999, EVENT_ID, "approved");
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("approving a second rider issues the same well-formed statement", async () => {
    // participant 1
    queryOne.mockResolvedValueOnce({ user_id: 11 });
    query.mockResolvedValueOnce([participantRow({ id: 1, user_id: 11 })]);
    await updateRegistrationStatus(1, EVENT_ID, "approved");

    // participant 2
    queryOne.mockResolvedValueOnce({ user_id: 22 });
    query.mockResolvedValueOnce([participantRow({ id: 2, user_id: 22 })]);
    await updateRegistrationStatus(2, EVENT_ID, "approved");

    for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
      expectEveryBoundParamIsReferenced(sql, params);
    }
    expect(query.mock.calls[0][1]).toEqual([EVENT_ID, "approved", 11]);
    expect(query.mock.calls[1][1]).toEqual([EVENT_ID, "approved", 22]);
  });
});
