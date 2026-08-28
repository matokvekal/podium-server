import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_LIMITS, type EffectiveLimits, resolveEffectiveLimits } from "./plan-limits.js";

describe("plan limits", () => {
  it("keeps the central defaults in one place", () => {
    expect(DEFAULT_PLAN_LIMITS).toEqual({
      maxEventsPerWeek: 3,
      maxParticipantsPerEvent: 50,
      maxGroupsPerEvent: 2,
      maxTeamsPerOwner: 2,
    });
  });
});

describe("resolveEffectiveLimits — per-field (override ?? plan)", () => {
  // What a free user's plan allows. PLANS.free reads DEFAULT_PLAN_LIMITS, so these are the
  // same numbers by construction.
  const FREE: EffectiveLimits = {
    maxEventsPerWeek: 3,
    maxParticipantsPerEvent: 50,
    maxGroupsPerEvent: 2,
    maxTeamsPerOwner: 2,
  };

  const PRO: EffectiveLimits = {
    maxEventsPerWeek: 30,
    maxParticipantsPerEvent: 500,
    maxGroupsPerEvent: 10,
    maxTeamsPerOwner: 5,
  };

  it("no user_entitlements row leaves the plan untouched — the pre-migration behaviour", () => {
    expect(resolveEffectiveLimits(FREE, null)).toEqual(FREE);
    expect(resolveEffectiveLimits(PRO, null)).toEqual(PRO);
  });

  it("an empty row is identical to no row", () => {
    expect(resolveEffectiveLimits(PRO, {})).toEqual(PRO);
  });

  it("a full custom row overrides the three stored limits", () => {
    expect(
      resolveEffectiveLimits(FREE, {
        maxEventsPerWeek: 10,
        maxParticipantsPerEvent: 200,
        maxGroupsPerEvent: 5,
      }),
    ).toEqual({
      maxEventsPerWeek: 10,
      maxParticipantsPerEvent: 200,
      maxGroupsPerEvent: 5,
      // teams-per-owner has no column in user_entitlements — always the plan value.
      maxTeamsPerOwner: 2,
    });
  });

  it("a partial row overrides only the field it names", () => {
    expect(resolveEffectiveLimits(FREE, { maxParticipantsPerEvent: 200 })).toEqual({
      ...FREE,
      maxParticipantsPerEvent: 200,
    });
  });

  it("can also tighten a single account", () => {
    expect(resolveEffectiveLimits(PRO, { maxEventsPerWeek: 1 })).toEqual({
      ...PRO,
      maxEventsPerWeek: 1,
    });
  });

  it("treats 0 as a real limit, not as absent", () => {
    // The trap this guards: `||` would read 0 as "unset" and silently hand back the plan's
    // number, which is the opposite of what setting 0 means.
    expect(resolveEffectiveLimits(FREE, { maxEventsPerWeek: 0 }).maxEventsPerWeek).toBe(0);
  });

  it("never lets user_entitlements change teams-per-owner", () => {
    expect(resolveEffectiveLimits(PRO, { maxEventsPerWeek: 1 }).maxTeamsPerOwner).toBe(5);
  });
});
