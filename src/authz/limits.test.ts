import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_LIMITS, type EffectiveLimits } from "../config/plan-limits.js";
import { ApiError } from "../lib/api-error.js";
import {
  assertWithinEventsPerWeek,
  assertWithinGroupLimit,
  assertWithinParticipantLimit,
  assertWithinTeamLimit,
} from "./limits.js";
import { hasRoomForParticipants, joinedParticipantCount } from "./participant-capacity.js";
import type { Actor } from "./policy.js";

// The assert helpers only ever read actor.entitlements.limits — a bare stub is all they need.
function actorWithLimits(limits: Partial<EffectiveLimits> = {}): Actor {
  return {
    userId: 1,
    globalRole: "RIDER",
    entitlements: { limits: { ...DEFAULT_PLAN_LIMITS, ...limits } },
  } as unknown as Actor;
}

const DEFAULT_ACTOR = actorWithLimits();

function expect409(fn: () => void) {
  expect(fn).toThrow(ApiError);
  try {
    fn();
  } catch (err) {
    expect((err as ApiError).status).toBe(409);
  }
}

describe("assertWithinEventsPerWeek — default limit 3", () => {
  it("allows a create while under the limit", () => {
    expect(() => assertWithinEventsPerWeek(DEFAULT_ACTOR, 2)).not.toThrow();
  });

  it("rejects once the limit is reached", () => {
    expect409(() => assertWithinEventsPerWeek(DEFAULT_ACTOR, 3));
  });
});

describe("assertWithinParticipantLimit — default limit 50, capacity = pending + approved", () => {
  it("allows the 50th rider (49 already on the list, adding 1)", () => {
    expect(() => assertWithinParticipantLimit(DEFAULT_ACTOR, 49, 1)).not.toThrow();
  });

  it("rejects the 51st (50 already on the list, adding 1)", () => {
    expect409(() => assertWithinParticipantLimit(DEFAULT_ACTOR, 50, 1));
  });

  it("counts approved + pending together — 42 + 8 is already full", () => {
    const current = joinedParticipantCount({ approved: 42, pending: 8 });
    expect(current).toBe(50);
    expect409(() => assertWithinParticipantLimit(DEFAULT_ACTOR, current, 1));
  });

  it("pending alone can fill a ride — 50 waiting, 0 approved", () => {
    const current = joinedParticipantCount({ approved: 0, pending: 50 });
    expect409(() => assertWithinParticipantLimit(DEFAULT_ACTOR, current, 1));
  });

  it("honours a raised per-user limit — 60 on a 200 ride is fine", () => {
    expect(() =>
      assertWithinParticipantLimit(actorWithLimits({ maxParticipantsPerEvent: 200 }), 60, 1),
    ).not.toThrow();
  });
});

describe("assertWithinGroupLimit — default limit 2", () => {
  it("allows a second group (1 already exists)", () => {
    expect(() => assertWithinGroupLimit(DEFAULT_ACTOR, 1)).not.toThrow();
  });

  it("rejects a third group (2 already exist)", () => {
    expect409(() => assertWithinGroupLimit(DEFAULT_ACTOR, 2));
  });
});

describe("assertWithinTeamLimit — default limit 2", () => {
  it("rejects a third team", () => {
    expect409(() => assertWithinTeamLimit(DEFAULT_ACTOR, 2));
  });
});

describe("hasRoomForParticipants — the shared pending+approved capacity rule", () => {
  it.each([
    [{ approved: 40, pending: 9 }, 1, 50, true], // 49 -> ok
    [{ approved: 49, pending: 1 }, 1, 50, false], // 50 -> full
    [{ approved: 42, pending: 8 }, 1, 50, false], // 42 + 8 -> full
    [{ approved: 0, pending: 50 }, 1, 50, false], // pending alone fills it
    [{ approved: 10, pending: 0 }, 40, 50, true], // an import that exactly fits
    [{ approved: 10, pending: 0 }, 41, 50, false], // an import one over
  ])("counts %o + %d against %d -> %s", (counts, adding, max, ok) => {
    expect(hasRoomForParticipants(counts, adding, max)).toBe(ok);
  });
});

describe("the OWNER's actor is what the caps are checked against", () => {
  // Full DB integration is not possible in this repo (no test database). This documents the
  // contract that event.service.joinEvent / participant.service.assertRoomForRiders /
  // group.service.createGroup all resolve buildActor(event.ownerId) — never the caller — so a
  // free-plan rider joining a Pro organizer's ride is measured against the organizer's limit.
  it("a Pro owner's 500-rider limit admits rider #300 regardless of who is joining", () => {
    const owner = actorWithLimits({ maxParticipantsPerEvent: 500 });
    expect(() => assertWithinParticipantLimit(owner, 299, 1)).not.toThrow();
  });
});
