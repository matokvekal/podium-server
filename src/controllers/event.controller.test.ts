// The owner-only redaction of the start-list ceiling.
//
// "the creator himself can see register/total he can for example 6/50, all other riders when
// they see the page will see just registers like 7 that all." `participantCount` is public;
// `maxParticipants` (the organizer's user_limits.participants_per_event) is not. This file
// exists because that is a privacy rule — the kind of thing a later refactor "tidies" back
// into an unconditional field without noticing — so it is pinned rather than left to review.
//
// This repo has no test database, so ../db/pool.js is stubbed; toEventDetail is a pure mapper
// and never touches it, but importing the controller module pulls the pool in transitively.

import { describe, expect, it, vi } from "vitest";

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { toEventDetail } = await import("./event.controller.js");

const OWNER_ID = 7;
const STRANGER_ID = 99;

/** Only the fields toEventDetail actually reads; the rest of Event is irrelevant here. */
const event = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "01012026A",
  name: "Saturday ride",
  type: "RIDE",
  ownerId: OWNER_ID,
  status: "published",
  visibility: "public",
  startsAt: new Date("2026-01-03T06:00:00Z"),
  endsAt: null,
  finishedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  requiresBib: false,
  requiresApproval: false,
  isPaused: false,
  isActive: true,
  description: null,
  location: null,
  area: null,
  expectedParticipants: 40,
} as unknown as Parameters<typeof toEventDetail>[0];

/** 6 riders on a start list whose owner is allowed 50 — the numbers from the request. */
const capacity = {
  participantCount: 6,
  maxParticipants: 50,
  groupCount: 1,
  maxGroups: 2,
};

function detailFor(viewerId: number | null) {
  return toEventDetail(event, viewerId, null, "owner", null, null, null, null, capacity);
}

describe("toEventDetail — the start-list ceiling is the owner's alone", () => {
  it("gives the organizer both halves of '6 / 50'", () => {
    const detail = detailFor(OWNER_ID);

    expect(detail.isOwner).toBe(true);
    expect(detail.participantCount).toBe(6);
    expect(detail.maxParticipants).toBe(50);
  });

  it("gives another rider the count but never the ceiling", () => {
    const detail = detailFor(STRANGER_ID);

    expect(detail.isOwner).toBe(false);
    expect(detail.participantCount).toBe(6);
    // null, not 50 and not the free-tier default: the client renders a bare "6" from this.
    expect(detail.maxParticipants).toBeNull();
    expect(detail.maxGroups).toBeNull();
  });

  it("redacts for a signed-out viewer too", () => {
    expect(detailFor(null).maxParticipants).toBeNull();
  });

  it("still tells a non-owner whether the ride is full, without naming the cap", () => {
    // A rider has to know they cannot join; a boolean says so without leaking the number.
    const full = toEventDetail(event, STRANGER_ID, null, "owner", null, null, null, null, {
      ...capacity,
      participantCount: 50,
    });

    expect(full.isFull).toBe(true);
    expect(full.maxParticipants).toBeNull();
  });

  it("does not fall back to a ceiling when capacity was not resolved", () => {
    const detail = toEventDetail(event, OWNER_ID, null, "owner", null, null, null, null, null);

    expect(detail.maxParticipants).toBeNull();
    expect(detail.isFull).toBe(false);
  });
});
