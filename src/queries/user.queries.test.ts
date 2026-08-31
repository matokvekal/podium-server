// Creating a user must create their limits, in the same transaction. A user committed without
// a user_limits row could not make a single authenticated request, because resolveEntitlements
// throws rather than falling back — so this is an integrity test, not a convenience one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const txQuery = vi.fn();
const txQueryOne = vi.fn();
const rollback = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue(0),
  /** Mirrors the real helper: any throw inside `fn` rolls back and nothing commits. */
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    try {
      return await fn({ query: txQuery, queryOne: txQueryOne });
    } catch (err) {
      rollback();
      throw err;
    }
  },
}));

const { insertUserWithIdentity } = await import("./user.queries.js");

const USER_ROW = {
  id: 42,
  first_name: "Dana",
  last_name: null,
  nickname: null,
  avatar_url: null,
  role: "USER",
  created_at: new Date(0),
  updated_at: new Date(0),
  last_login_at: new Date(0),
};

const INPUT = {
  provider: "GOOGLE" as const,
  providerUserId: "google-123",
  email: "rider@example.com",
  phone: null,
  firstName: "Dana",
  lastName: null,
  avatarUrl: null,
  now: new Date(0),
};

/** The statements the transaction ran, in order. */
const sqlRun = () => txQuery.mock.calls.map(([sql]) => sql as string);

beforeEach(() => {
  txQuery.mockReset().mockResolvedValue([]);
  txQueryOne.mockReset().mockResolvedValue(USER_ROW);
  rollback.mockReset();
});

describe("insertUserWithIdentity", () => {
  it("creates a user_limits row for every new user", async () => {
    await insertUserWithIdentity(INPUT);

    const limitsInsert = sqlRun().find((sql) => sql.includes("INSERT INTO user_limits"));
    expect(limitsInsert).toBeDefined();
  });

  it("writes the configured defaults as real values, never NULL", async () => {
    await insertUserWithIdentity(INPUT);

    const call = txQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO user_limits"),
    );
    expect(call?.[1]).toEqual([42, 3, 50, 2, 2, "created with user"]);
  });

  it("uses the id of the user it just inserted", async () => {
    txQueryOne.mockResolvedValue({ ...USER_ROW, id: 99 });

    await insertUserWithIdentity(INPUT);

    const call = txQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO user_limits"),
    );
    expect(call).toBeDefined();
    expect((call?.[1] as unknown[])?.[0]).toBe(99);
  });

  it("runs inside the same transaction as the user and the identity", async () => {
    await insertUserWithIdentity(INPUT);

    const run = sqlRun();
    expect(run.some((sql) => sql.includes("INSERT INTO auth_identities"))).toBe(true);
    expect(run.some((sql) => sql.includes("INSERT INTO user_limits"))).toBe(true);
    // Limits come after the identity, and both are on the tx handle — not the pool.
    expect(run.findIndex((s) => s.includes("user_limits"))).toBeGreaterThan(
      run.findIndex((s) => s.includes("auth_identities")),
    );
  });

  it("rolls the whole thing back when the limits insert fails", async () => {
    // The case that matters: no half-created user who can never authenticate.
    txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("user_limits")) throw new Error("limits insert failed");
      return [];
    });

    await expect(insertUserWithIdentity(INPUT)).rejects.toThrow("limits insert failed");
    expect(rollback).toHaveBeenCalledOnce();
  });
});
