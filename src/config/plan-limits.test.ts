import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_LIMITS,
  normalizeUserLimitValues,
  resolveEffectiveLimits,
} from "./plan-limits.js";

describe("plan limits", () => {
  it("keeps the central defaults in one place", () => {
    expect(DEFAULT_PLAN_LIMITS).toEqual({
      eventsPerWeek: 3,
      participantsPerEvent: 50,
      groupsPerEvent: 2,
      teamsOwned: 2,
    });
  });

  it("falls back to defaults when DB values are missing", () => {
    expect(normalizeUserLimitValues(null)).toEqual(DEFAULT_PLAN_LIMITS);
    expect(normalizeUserLimitValues({})).toEqual(DEFAULT_PLAN_LIMITS);
    expect(
      normalizeUserLimitValues({
        events_per_week: 10,
        participants_per_event: 75,
        groups_per_event: 4,
        teams_owned: 5,
      }),
    ).toEqual({
      eventsPerWeek: 10,
      participantsPerEvent: 75,
      groupsPerEvent: 4,
      teamsOwned: 5,
    });
  });
});

describe("resolveEffectiveLimits — override ?? plan", () => {
  // What a free user's plan allows. PLANS.free reads DEFAULT_PLAN_LIMITS, so these are the
  // same numbers by construction.
  const FREE = {
    eventsPerWeek: 3,
    participantsPerEvent: 50,
    groupsPerEvent: 2,
    teamsPerOwner: 2,
  };

  const PRO = {
    eventsPerWeek: 30,
    participantsPerEvent: 500,
    groupsPerEvent: 10,
    teamsPerOwner: 5,
  };

  it("no row at all leaves the plan untouched — the pre-migration behaviour", () => {
    expect(resolveEffectiveLimits(FREE, null)).toEqual(FREE);
    expect(resolveEffectiveLimits(PRO, null)).toEqual(PRO);
  });

  it("a row of all NULLs is identical to no row", () => {
    expect(resolveEffectiveLimits(PRO, {})).toEqual(PRO);
    expect(
      resolveEffectiveLimits(PRO, {
        events_per_week: null,
        participants_per_event: null,
        groups_per_event: null,
        teams_owned: null,
      }),
    ).toEqual(PRO);
  });

  it("raises one user without touching their other limits", () => {
    expect(resolveEffectiveLimits(FREE, { events_per_week: 20 })).toEqual({
      ...FREE,
      eventsPerWeek: 20,
    });
  });

  it("can also tighten a single account", () => {
    expect(resolveEffectiveLimits(PRO, { events_per_week: 1 })).toEqual({
      ...PRO,
      eventsPerWeek: 1,
    });
  });

  it("treats 0 as a real limit, not as absent", () => {
    // The trap this guards: `||` would read 0 as "unset" and silently hand back the plan's
    // number, which is the opposite of what setting 0 means.
    expect(resolveEffectiveLimits(FREE, { events_per_week: 0 }).eventsPerWeek).toBe(0);
  });

  it("maps the teams_owned column onto teamsPerOwner", () => {
    expect(resolveEffectiveLimits(FREE, { teams_owned: 9 }).teamsPerOwner).toBe(9);
  });

  it("overrides every limit at once", () => {
    expect(
      resolveEffectiveLimits(FREE, {
        events_per_week: 20,
        participants_per_event: 200,
        groups_per_event: 8,
        teams_owned: 4,
      }),
    ).toEqual({
      eventsPerWeek: 20,
      participantsPerEvent: 200,
      groupsPerEvent: 8,
      teamsPerOwner: 4,
    });
  });
});
