// The load-bearing test file for this design: it pins that the request path reads user_limits
// and NOTHING else for the numbers, and that a plan grant reaches a user only by having been
// copied into that row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const txQuery = vi.fn();
const txQueryOne = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: txQuery, queryOne: txQueryOne }),
}));

const limitsQuery = vi.fn();
vi.mock("../queries/userLimits.queries.js", async () => {
  const actual = await vi.importActual<typeof import("../queries/userLimits.queries.js")>(
    "../queries/userLimits.queries.js",
  );
  return {
    ...actual,
    selectUserLimitsOrThrow: (...args: unknown[]) => limitsQuery(...args),
    applyPlanLimitsTx: (...args: unknown[]) => applyPlanLimits(...args),
  };
});
const applyPlanLimits = vi.fn();

const { grantEntitlement, resolveEntitlements, syncUserLimitsFromGrantsTx } = await import(
  "./entitlements.js"
);
const { UserLimitsNotFoundError } = await import("../queries/userLimits.queries.js");

const FREE_ROW = {
  maxEventsPerWeek: 3,
  maxParticipantsPerEvent: 50,
  maxGroupsPerEvent: 2,
  maxTeamsPerOwner: 2,
};

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  txQuery.mockReset().mockResolvedValue([]);
  txQueryOne.mockReset().mockResolvedValue({ id: 1 });
  limitsQuery.mockReset().mockResolvedValue(FREE_ROW);
  applyPlanLimits.mockReset().mockResolvedValue(undefined);
});

describe("resolveEntitlements — user_limits is the only source of the numbers", () => {
  it("hands back exactly what the row says", async () => {
    limitsQuery.mockResolvedValue({ ...FREE_ROW, maxEventsPerWeek: 10 });

    const result = await resolveEntitlements(42);

    expect(result.limits).toEqual({ ...FREE_ROW, maxEventsPerWeek: 10 });
  });

  it("a DB change from 3 to 10 takes effect with no deploy and no config change", async () => {
    limitsQuery.mockResolvedValue(FREE_ROW);
    expect((await resolveEntitlements(42)).limits.maxEventsPerWeek).toBe(3);

    // The only thing that changed is the row.
    limitsQuery.mockResolvedValue({ ...FREE_ROW, maxEventsPerWeek: 10 });
    expect((await resolveEntitlements(42)).limits.maxEventsPerWeek).toBe(10);
  });

  it("does NOT let a Pro plan grant raise the numbers on its own", async () => {
    // A live organizer_pro grant (30/week) with a row that still says 3. Under the previous
    // merge-based resolution this returned 30. It must now return 3 — the grant only counts
    // once it has been written into user_limits.
    query.mockResolvedValue([
      {
        id: 1,
        user_id: 42,
        plan_code: "organizer_pro",
        feature: null,
        quantity: null,
        consumed: 0,
        scope_type: null,
        scope_id: null,
        source: "subscription",
        source_ref: null,
        starts_at: new Date(0),
        expires_at: null,
      },
    ]);
    limitsQuery.mockResolvedValue(FREE_ROW);

    const result = await resolveEntitlements(42);

    expect(result.limits.maxEventsPerWeek).toBe(3);
    // The plan LABEL and its features still come from the grant — only the numbers moved.
    expect(result.plan.code).toBe("organizer_pro");
    expect(result.features.has("advanced_results")).toBe(true);
  });

  it("surfaces a manual create_events feature grant on a free account", async () => {
    // The organizer-access path: a free user (no plan grant) handed the create_events feature
    // by hand. It must land in `features` so canAccount(event:create) passes.
    query.mockResolvedValue([
      {
        id: 7,
        user_id: 42,
        plan_code: null,
        feature: "create_events",
        quantity: null,
        consumed: 0,
        scope_type: null,
        scope_id: null,
        source: "manual",
        source_ref: "organizer-access:launch",
        starts_at: new Date(0),
        expires_at: null,
      },
    ]);
    limitsQuery.mockResolvedValue(FREE_ROW);

    const result = await resolveEntitlements(42);

    expect(result.plan.code).toBe("free");
    expect(result.features.has("create_events")).toBe(true);
  });

  it("propagates UserLimitsNotFoundError instead of substituting a default", async () => {
    limitsQuery.mockRejectedValueOnce(new UserLimitsNotFoundError(42));

    await expect(resolveEntitlements(42)).rejects.toThrow(UserLimitsNotFoundError);
  });

  it("never reaches the database for a signed-out caller", async () => {
    const result = await resolveEntitlements(null);

    expect(query).not.toHaveBeenCalled();
    expect(limitsQuery).not.toHaveBeenCalled();
    expect(result.plan.code).toBe("free");
  });
});

describe("syncUserLimitsFromGrantsTx — the bridge that keeps plans meaningful", () => {
  it("writes the Pro numbers when a Pro grant is live", async () => {
    txQuery.mockResolvedValue([{ plan_code: "organizer_pro" }]);

    await syncUserLimitsFromGrantsTx({ query: txQuery, queryOne: txQueryOne }, 42);

    expect(applyPlanLimits).toHaveBeenCalledWith(
      expect.anything(),
      42,
      { maxEventsPerWeek: 30, maxParticipantsPerEvent: 500, maxGroupsPerEvent: 10, maxTeamsPerOwner: 5 },
      "plan:organizer_pro",
    );
  });

  it("writes the FREE numbers back when no plan grant is live — the downgrade path", async () => {
    txQuery.mockResolvedValue([]);

    await syncUserLimitsFromGrantsTx({ query: txQuery, queryOne: txQueryOne }, 42);

    expect(applyPlanLimits).toHaveBeenCalledWith(expect.anything(), 42, FREE_ROW, "plan:free");
  });

  it("takes the most generous number per limit when several plans are held at once", async () => {
    txQuery.mockResolvedValue([{ plan_code: "organizer_pro" }, { plan_code: "club" }]);

    await syncUserLimitsFromGrantsTx({ query: txQuery, queryOne: txQueryOne }, 42);

    expect(applyPlanLimits).toHaveBeenCalledWith(
      expect.anything(),
      42,
      { maxEventsPerWeek: 250, maxParticipantsPerEvent: 5000, maxGroupsPerEvent: 25, maxTeamsPerOwner: 50 },
      "plan:club",
    );
  });
});

describe("grantEntitlement", () => {
  it("moves user_limits in the same transaction as a plan grant", async () => {
    txQuery.mockResolvedValue([{ plan_code: "organizer_pro" }]);

    await grantEntitlement({ userId: 42, planCode: "organizer_pro", source: "subscription" });

    expect(applyPlanLimits).toHaveBeenCalledOnce();
    expect(applyPlanLimits.mock.calls[0][3]).toBe("plan:organizer_pro");
  });

  it("leaves user_limits alone for a feature-only grant", async () => {
    // Rewriting the row here would stamp a support override back down to the plan value.
    await grantEntitlement({ userId: 42, feature: "private_events", source: "purchase" });

    expect(applyPlanLimits).not.toHaveBeenCalled();
  });
});
