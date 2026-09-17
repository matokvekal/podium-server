// Writing events.terrain_grade (sql/038) — and the reason it rides along with the ride plan.
//
// ⚠ THE PROPERTY THIS FILE EXISTS FOR
//   terrain_grade is deliberately NOT its own guarded writer. It goes through
//   updateEventRidePlan -> updateEventColumns, which drops ONLY the column a 42703 names and
//   retries with the rest. So on a database that has not had sql/038 applied, an organizer's
//   duration, rest stops, accessibility and support vehicle are all still written and only the
//   grade is skipped.
//
//   That distinction is not theoretical: the header on updateEventColumns records a live
//   incident where a single missing column (expected_participants) silently discarded four
//   others on every ride edit. A separate try/catch around the whole batch is exactly the bug
//   that caused it, which is why the batching is asserted rather than assumed.
//
// No test database: ../db/pool.js is stubbed and the assertions are on what was asked of it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  withTransaction: vi.fn(),
}));

const { updateEventRidePlan, selectEventById } = await import("./event.queries.js");

/** Postgres undefined_column, naming one specific column the way the real error does. */
function missingColumn(name: string) {
  return Object.assign(new Error(`column "${name}" of relation "events" does not exist`), {
    code: "42703",
  });
}

const FULL_PLAN = {
  durationMin: 150,
  restStops: 2,
  isAccessible: false,
  hasSupportVehicle: true,
  expectedParticipants: 40,
  terrainGrade: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue(1);
});

describe("updateEventRidePlan — terrain_grade in the batch", () => {
  it("writes it alongside the rest, in one statement", async () => {
    await updateEventRidePlan("e1", FULL_PLAN);

    expect(execute).toHaveBeenCalledTimes(1);
    const [text, params] = execute.mock.calls[0];
    expect(text).toContain("terrain_grade = $");
    expect(params).toContain(3);
    // Parameterized, never interpolated.
    expect(text).not.toContain("= 3");
  });

  it("skips the column entirely when the key is absent, so an edit never wipes it", async () => {
    await updateEventRidePlan("e1", { durationMin: 150 });

    const [text] = execute.mock.calls[0];
    expect(text).not.toContain("terrain_grade");
  });

  it("writes an explicit null, which is how an organizer clears it", async () => {
    await updateEventRidePlan("e1", { terrainGrade: null });

    const [text, params] = execute.mock.calls[0];
    expect(text).toContain("terrain_grade = $2");
    expect(params).toEqual(["e1", null]);
  });

  it("asks nothing at all when no ride-plan key was sent", async () => {
    await updateEventRidePlan("e1", {});
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("⚠ degrading on a database without sql/038", () => {
  it("still writes the other five columns, dropping only the grade", async () => {
    // First attempt names terrain_grade as missing; the retry must carry everything else.
    execute.mockRejectedValueOnce(missingColumn("terrain_grade")).mockResolvedValueOnce(1);

    await updateEventRidePlan("e1", FULL_PLAN);

    expect(execute).toHaveBeenCalledTimes(2);
    const retry = execute.mock.calls[1][0] as string;
    expect(retry).not.toContain("terrain_grade");
    expect(retry).toContain("duration_min");
    expect(retry).toContain("rest_stops");
    expect(retry).toContain("is_accessible");
    expect(retry).toContain("has_support_vehicle");
    expect(retry).toContain("expected_participants");
  });

  it("does not throw — an unapplied migration is not an organizer's problem", async () => {
    execute.mockRejectedValueOnce(missingColumn("terrain_grade")).mockResolvedValueOnce(1);
    await expect(updateEventRidePlan("e1", FULL_PLAN)).resolves.toBeUndefined();
  });

  it("and the reverse still holds: a different missing column does not lose the grade", async () => {
    execute.mockRejectedValueOnce(missingColumn("expected_participants")).mockResolvedValueOnce(1);

    await updateEventRidePlan("e1", FULL_PLAN);

    const retry = execute.mock.calls[1][0] as string;
    expect(retry).toContain("terrain_grade");
    expect(retry).not.toContain("expected_participants");
  });
});

describe("reading it back", () => {
  it("comes free with SELECT * — no query change was needed for the new column", async () => {
    queryOne.mockResolvedValue(null);
    await selectEventById("e1");
    expect(queryOne.mock.calls[0][0]).toContain("SELECT * FROM events");
  });
});
