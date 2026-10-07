// The one rule for "how full is a start list", so joinEvent, the manual-add / import path and
// the event-detail payload all count the same way.
//
// A rider takes up a slot the moment they are on the list and have not left — whether they
// are approved (`registered` / `approved`) or still `waiting_approval`. Rejected riders and
// riders who left never count. This is deliberately stricter than "approved only": an
// approval-required ride that is already at its cap must stop taking new pending requests,
// not queue them past the limit.

export interface JoinedCounts {
  approved: number;
  pending: number;
}

/** Slots currently taken = approved + still-pending. */
export function joinedParticipantCount(counts: JoinedCounts): number {
  return counts.approved + counts.pending;
}

/**
 * The ceiling for one ride: the System Admin's per-ride override (events.max_participants,
 * sql/060) when set, otherwise the owner's account cap. Only the number changes — the counting
 * above is the same either way.
 */
export function effectiveMaxParticipants(
  event: { maxParticipants?: number | null },
  ownerMaxParticipantsPerEvent: number,
): number {
  return event.maxParticipants ?? ownerMaxParticipantsPerEvent;
}

/** True when `adding` more riders still fits under `max`. */
export function hasRoomForParticipants(counts: JoinedCounts, adding: number, max: number): boolean {
  return joinedParticipantCount(counts) + adding <= max;
}
