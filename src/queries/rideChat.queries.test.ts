// Pins the SQL shape of the ride chat reads: by ride_id, the afterId cursor, and the unread
// summary's access rule (the SQL twin of policy.ts "event:chat").

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db/pool.js", () => ({
  query: (...a: unknown[]) => query(...a),
  withTransaction: vi.fn(),
}));

const { selectRideChatMessages, selectUnreadSummary } = await import("./rideChat.queries.js");

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue([]);
});

describe("selectRideChatMessages", () => {
  it("reads one ride, oldest first, only after the cursor", async () => {
    await selectRideChatMessages("r1", 42, 500);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE m\.ride_id = \$1/);
    expect(sql).toMatch(/m\.id > \$2::bigint/);
    expect(sql).toMatch(/ORDER BY m\.id\s+LIMIT \$3/);
    expect(params).toEqual(["r1", 42, 500]);
  });
});

describe("selectUnreadSummary", () => {
  it("makes no query for an empty list", async () => {
    await expect(selectUnreadSummary(7, [], 100)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers every ride in one statement, only for rides the caller is on", async () => {
    await selectUnreadSummary(
      7,
      [
        { rideId: "a", lastReadId: 3 },
        { rideId: "b", lastReadId: 0 },
      ],
      100,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("unnest($2::uuid[], $3::bigint[])");
    expect(sql).toContain("e.owner_id = $1");
    expect(sql).toContain("em.role IN ('owner', 'operator')");
    expect(sql).toContain("ep.registration_status IN ('registered', 'approved')");
    // Your own messages are never unread.
    expect(sql).toContain("m.user_id <> $1");
    expect(params).toEqual([7, ["a", "b"], [3, 0], 100]);
  });
});
