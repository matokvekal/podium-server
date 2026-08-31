// The defaults are a TEMPLATE, read once when a user_limits row is created. These tests pin
// that they come from the environment, and — just as importantly — that nothing else reads
// them on the request path. The runtime side of that is proved in authz/entitlements.test.ts.
//
// The max* field names come from the branch that modelled this as `user_entitlements`; the
// names were kept on merge because controllers and services already read them.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** env.ts parses process.env at module load, so each case needs a fresh module graph. */
async function loadDefaults(overrides: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  const { getDefaultUserLimits } = await import("./plan-limits.js");
  return getDefaultUserLimits();
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("getDefaultUserLimits", () => {
  it("falls back to the documented product defaults when nothing is configured", async () => {
    expect(await loadDefaults()).toEqual({
      maxEventsPerWeek: 3,
      maxParticipantsPerEvent: 50,
      maxGroupsPerEvent: 2,
      maxTeamsPerOwner: 2,
    });
  });

  it("takes every value from the environment", async () => {
    expect(
      await loadDefaults({
        DEFAULT_EVENTS_PER_WEEK: "7",
        DEFAULT_PARTICIPANTS_PER_EVENT: "120",
        DEFAULT_GROUPS_PER_EVENT: "4",
        DEFAULT_TEAMS_OWNED: "9",
      }),
    ).toEqual({
      maxEventsPerWeek: 7,
      maxParticipantsPerEvent: 120,
      maxGroupsPerEvent: 4,
      maxTeamsPerOwner: 9,
    });
  });

  it("DEFAULT_EVENTS_PER_WEEK=3 is what a new user is created with", async () => {
    // The task's stated acceptance case, kept as its own test so it fails by name.
    const defaults = await loadDefaults({ DEFAULT_EVENTS_PER_WEEK: "3" });
    expect(defaults.maxEventsPerWeek).toBe(3);
  });

  it("accepts 0 — a real limit, not an unset value", async () => {
    expect((await loadDefaults({ DEFAULT_EVENTS_PER_WEEK: "0" })).maxEventsPerWeek).toBe(0);
  });
});
