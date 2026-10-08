// Event Completion Medals (sql/061): the award is one idempotent INSERT with the Statistics
// eligibility rule, and every medal path is fail-safe — a medal problem never breaks anything.

import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
const resolveFactsOptions = vi.fn();

vi.mock("../db/pool.js", () => ({
  execute: (...a: unknown[]) => execute(...a),
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
  withTransaction: vi.fn(),
}));
vi.mock("../statistics/statistics.service.js", () => ({
  resolveFactsOptions: () => resolveFactsOptions(),
}));

const medals = await import("./eventMedals.service.js");

const missingTable = Object.assign(new Error('relation "event_medal_awards" does not exist'), {
  code: "42P01",
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveFactsOptions.mockResolvedValue({ requireCheckinFrom: null });
});

describe("awardMedalsForFinishedEvent", () => {
  it("is one INSERT ... SELECT guarded by medal_enabled, finished, and the Statistics rider rule", async () => {
    execute.mockResolvedValue(3);
    await expect(medals.awardMedalsForFinishedEvent("e1")).resolves.toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO event_medal_awards");
    expect(sql).toContain("e.status = 'finished'");
    expect(sql).toContain("e.medal_enabled = TRUE");
    expect(sql).toContain("COALESCE(btrim(e.medal_text), '') <> ''");
    expect(sql).toContain("ep.registration_status IN ('registered', 'approved')");
    expect(sql).toContain("ep.left_at IS NULL");
    expect(sql).toContain("ep.user_id IS NOT NULL");
    expect(params).toEqual(["e1"]);
  });

  it("is idempotent at the database: ON CONFLICT (event_id, user_id) DO NOTHING", async () => {
    execute.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await medals.awardMedalsForFinishedEvent("e1");
    await expect(medals.awardMedalsForFinishedEvent("e1")).resolves.toBe(0);
    for (const [sql] of execute.mock.calls) {
      expect(sql).toContain("ON CONFLICT (event_id, user_id) DO NOTHING");
    }
  });

  it("a ride nobody rode (never live, no GPS, nobody checked in) gets no medals", async () => {
    execute.mockResolvedValue(0);
    await medals.awardMedalsForFinishedEvent("e1");
    const [sql] = execute.mock.calls[0];
    expect(sql).toContain("e.started_at IS NOT NULL");
    expect(sql).toContain("ep.attendance_status IN ('present', 'started')");
    expect(sql).toContain("FROM participant_tracks");
  });

  it("applies the check-in rule exactly when Statistics does", async () => {
    const from = new Date("2026-09-01T00:00:00Z");
    resolveFactsOptions.mockResolvedValue({ requireCheckinFrom: from });
    execute.mockResolvedValue(1);
    await medals.awardMedalsForFinishedEvent("e1");
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("COALESCE(e.starts_at, e.finished_at) < $2");
    expect(params).toEqual(["e1", from]);
  });

  it("never throws: a DB failure or a missing sql/061 is logged and awards nothing", async () => {
    execute.mockRejectedValueOnce(new Error("connection reset"));
    await expect(medals.awardMedalsForFinishedEvent("e1")).resolves.toBe(0);
    execute.mockRejectedValueOnce(missingTable);
    await expect(medals.awardMedalsForFinishedEvent("e1")).resolves.toBe(0);
  });
});

describe("catchUpRecentMedalAwards", () => {
  it("re-runs the award for recent medal rides and never throws", async () => {
    query.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    execute.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("boom"));
    await expect(medals.catchUpRecentMedalAwards()).resolves.toBe(0);
    expect(execute.mock.calls.map((c) => c[1][0])).toEqual(["a", "b"]);

    query.mockRejectedValueOnce(missingTable);
    await expect(medals.catchUpRecentMedalAwards()).resolves.toBe(0);
  });
});

describe("my medals", () => {
  const row = (id: number, iso: string) => ({
    id: String(id),
    event_id: `e${id}`,
    event_title: `Ride ${id}`,
    event_date: new Date(iso),
    medal_text: "Well ridden",
    awarded_at: new Date(iso),
    seen_at: null,
  });

  it("pages newest first by (awarded_at, id) and only for the caller", async () => {
    query.mockResolvedValueOnce([
      row(3, "2026-10-03T00:00:00Z"),
      row(2, "2026-10-02T00:00:00Z"),
      row(1, "2026-10-01T00:00:00Z"),
    ]);
    queryOne.mockResolvedValueOnce({ total: "3", unseen: "3" });
    const page = await medals.listMyMedals(42, 2, undefined);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("WHERE user_id = $1");
    expect(sql).toContain("ORDER BY awarded_at DESC, id DESC");
    expect(params).toEqual([42, 3]);
    expect(page.medals.map((m) => m.eventId)).toEqual(["e3", "e2"]);
    expect(page.nextCursor).toBe("2026-10-02T00:00:00.000Z_2");
    expect(page.total).toBe(3);

    query.mockResolvedValueOnce([row(1, "2026-10-01T00:00:00Z")]);
    const next = await medals.listMyMedals(42, 2, page.nextCursor ?? undefined);
    expect(query.mock.calls[1][0]).toContain("(awarded_at, id) < ($3, $4)");
    expect(query.mock.calls[1][1]).toEqual([42, 3, new Date("2026-10-02T00:00:00Z"), 2]);
    expect(next.nextCursor).toBeNull();
  });

  it("a bad cursor is a 400, not a 500", async () => {
    await expect(medals.listMyMedals(42, 20, "garbage")).rejects.toMatchObject({ status: 400 });
  });

  it("a database without sql/061 is an empty collection", async () => {
    query.mockRejectedValueOnce(missingTable);
    await expect(medals.listMyMedals(42, 20, undefined)).resolves.toEqual({
      medals: [],
      nextCursor: null,
      total: 0,
      unseen: 0,
    });
  });

  it("seen only ever touches the caller's own rows", async () => {
    execute.mockResolvedValue(1);
    await medals.markMyMedalsSeen(42, ["e1"]);
    await medals.markMyMedalsSeen(42, null);
    for (const [sql, params] of execute.mock.calls) {
      expect(sql).toContain("WHERE user_id = $1 AND seen_at IS NULL");
      expect(params[0]).toBe(42);
    }
  });

  it("unseen count never throws (the profile must load)", async () => {
    queryOne.mockResolvedValueOnce({ n: "2" });
    await expect(medals.getUnseenMedalCount(42)).resolves.toBe(2);
    queryOne.mockRejectedValueOnce(new Error("down"));
    await expect(medals.getUnseenMedalCount(42)).resolves.toBe(0);
  });

  it("my-rides decoration is one batched query and fails to 'no medals'", async () => {
    query.mockResolvedValueOnce([{ event_id: "e2" }]);
    await expect(medals.selectMyMedalEventIds(42, ["e1", "e2", "e3"])).resolves.toEqual(
      new Set(["e2"]),
    );
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRejectedValueOnce(missingTable);
    await expect(medals.selectMyMedalEventIds(42, ["e1"])).resolves.toEqual(new Set());
    await expect(medals.selectMyMedalEventIds(42, [])).resolves.toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(2);
  });
});
