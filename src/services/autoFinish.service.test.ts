// The sweeper's contract: flip each due ride exactly once, stamp it with the RIDE's end time, run
// the same two follow-ups an organizer's Finish gets, and never let one bad ride stop the rest.
// The queries are stubbed (no test database) — the SQL itself is exercised against a real
// Postgres by hand, see the report for this change.

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectEventsDueForAutoFinish = vi.fn();
const autoFinishEvent = vi.fn();
const writeParticipantTracks = vi.fn();
const refreshStatsForFinishedEvent = vi.fn();

vi.mock("../queries/event.queries.js", () => ({
  selectEventsDueForAutoFinish: (...a: unknown[]) => selectEventsDueForAutoFinish(...a),
  autoFinishEvent: (...a: unknown[]) => autoFinishEvent(...a),
}));
vi.mock("./track-writer.js", () => ({
  writeParticipantTracks: (...a: unknown[]) => writeParticipantTracks(...a),
}));
vi.mock("../statistics/statistics.service.js", () => ({
  refreshStatsForFinishedEvent: (...a: unknown[]) => refreshStatsForFinishedEvent(...a),
}));

const { runAutoFinishSweep, AUTO_FINISH_GRACE_HOURS } = await import("./autoFinish.service.js");

const ended = new Date("2026-08-30T09:00:00Z");
const due = (id: string, status = "live") => ({ id, status, rideEndedAt: ended });

beforeEach(() => {
  selectEventsDueForAutoFinish.mockReset().mockResolvedValue([]);
  autoFinishEvent.mockReset().mockResolvedValue(true);
  writeParticipantTracks.mockReset().mockResolvedValue(0);
  refreshStatsForFinishedEvent.mockReset().mockResolvedValue(undefined);
});

describe("runAutoFinishSweep", () => {
  it("asks for rides a full day past their end", async () => {
    await runAutoFinishSweep();
    expect(AUTO_FINISH_GRACE_HOURS).toBe(24);
    expect(selectEventsDueForAutoFinish).toHaveBeenCalledWith(24, expect.any(Number));
  });

  it("finishes a due ride with the ride's own end time, then saves tracks and refreshes stats", async () => {
    selectEventsDueForAutoFinish.mockResolvedValue([due("e1")]);

    const n = await runAutoFinishSweep();

    expect(n).toBe(1);
    expect(autoFinishEvent).toHaveBeenCalledWith("e1", ended);
    expect(writeParticipantTracks).toHaveBeenCalledWith("e1");
    expect(refreshStatsForFinishedEvent).toHaveBeenCalledWith("e1");
    // Tracks first: location_points is purge-eligible, the saved line is the history.
    expect(writeParticipantTracks.mock.invocationCallOrder[0]).toBeLessThan(
      refreshStatsForFinishedEvent.mock.invocationCallOrder[0],
    );
  });

  it("skips the follow-ups for a ride an organizer finished first (guarded UPDATE lost the race)", async () => {
    selectEventsDueForAutoFinish.mockResolvedValue([due("e1")]);
    autoFinishEvent.mockResolvedValue(false);

    const n = await runAutoFinishSweep();

    expect(n).toBe(0);
    expect(writeParticipantTracks).not.toHaveBeenCalled();
    expect(refreshStatsForFinishedEvent).not.toHaveBeenCalled();
  });

  it("keeps going when one ride fails", async () => {
    selectEventsDueForAutoFinish.mockResolvedValue([due("bad"), due("good")]);
    autoFinishEvent.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);

    const n = await runAutoFinishSweep();

    expect(n).toBe(1);
    expect(refreshStatsForFinishedEvent).toHaveBeenCalledWith("good");
  });

  it("returns 0 instead of throwing when the listing itself fails (e.g. DB down)", async () => {
    selectEventsDueForAutoFinish.mockRejectedValue(new Error("db down"));
    await expect(runAutoFinishSweep()).resolves.toBe(0);
  });
});
