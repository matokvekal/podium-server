// The limit CHECK itself: usage is counted from the real tables and compared against the
// number in user_limits. These tests exist to pin "3 means 3" and "10 means 10" at the point
// where the rider actually gets refused.

import { describe, expect, it } from "vitest";
import {
  assertWithinEventsPerWeek,
  assertWithinGroupLimit,
  assertWithinParticipantLimit,
  assertWithinTeamLimit,
} from "./limits.js";
import type { Actor } from "./policy.js";

function actorWith(eventsPerWeek: number): Actor {
  return {
    entitlements: {
      limits: {
        eventsPerWeek,
        participantsPerEvent: 50,
        groupsPerEvent: 2,
        teamsPerOwner: 2,
      },
    },
  } as unknown as Actor;
}

describe("assertWithinEventsPerWeek", () => {
  it("permits up to the limit and refuses at it", () => {
    const actor = actorWith(3);

    expect(() => assertWithinEventsPerWeek(actor, 2)).not.toThrow();
    expect(() => assertWithinEventsPerWeek(actor, 3)).toThrow(/reached your rides for this week/);
  });

  it("raising the row from 3 to 10 permits the 4th through 10th ride", () => {
    // The support case end-to-end, at the check: same code, different number from the DB.
    const raised = actorWith(10);

    expect(() => assertWithinEventsPerWeek(raised, 3)).not.toThrow();
    expect(() => assertWithinEventsPerWeek(raised, 9)).not.toThrow();
    expect(() => assertWithinEventsPerWeek(raised, 10)).toThrow(/PLAN_LIMIT_EVENTS_PER_WEEK/);
  });

  it("puts the numbers in the message so the client need not make a second call", () => {
    expect(() => assertWithinEventsPerWeek(actorWith(3), 3)).toThrow(/used 3 of 3/);
  });

  it("answers 409, not 403 — out of allowance, not forbidden", () => {
    try {
      assertWithinEventsPerWeek(actorWith(3), 3);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status: number }).status).toBe(409);
    }
  });

  it("a limit of 0 refuses the very first ride", () => {
    expect(() => assertWithinEventsPerWeek(actorWith(0), 0)).toThrow();
  });
});

describe("the other three limits read the same row", () => {
  const actor = actorWith(3);

  it("refuses an import that would cross the participant limit as a whole", () => {
    expect(() => assertWithinParticipantLimit(actor, 40, 10)).not.toThrow();
    expect(() => assertWithinParticipantLimit(actor, 40, 11)).toThrow(/rider limit/);
  });

  it("refuses the group past the limit", () => {
    expect(() => assertWithinGroupLimit(actor, 1)).not.toThrow();
    expect(() => assertWithinGroupLimit(actor, 2)).toThrow(/ride-group limit/);
  });

  it("refuses the team past the limit", () => {
    expect(() => assertWithinTeamLimit(actor, 1)).not.toThrow();
    expect(() => assertWithinTeamLimit(actor, 2)).toThrow(/team limit/);
  });
});
