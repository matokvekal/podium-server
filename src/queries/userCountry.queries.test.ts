// updateUserCountry writes users.country on its own, guarded against a database that has not
// had sql/030-country.sql applied yet — the same pattern (and the same safety guarantee) as
// updateEventElevationGain.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { updateUserCountry } = await import("./user.queries.js");

const userRow = {
  id: 7,
  first_name: "Dana",
  last_name: "Levi",
  nickname: "dana",
  emergency_phone: null,
  avatar_url: null,
  avatar_type: null,
  avatar_value: null,
  cover_type: null,
  cover_value: null,
  country: "IL",
  role: "RIDER",
  is_active: true,
  created_at: new Date(0),
  updated_at: new Date(0),
  last_login_at: null,
};

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("updateUserCountry", () => {
  it("writes the two-letter code and returns the refreshed user", async () => {
    query.mockResolvedValueOnce([{ ...userRow, country: "FR" }]);

    const user = await updateUserCountry(7, "FR");

    expect(user?.country).toBe("FR");
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE users SET country = \$2/);
    expect(params).toEqual([7, "FR"]);
  });

  it("no-ops on a null/empty code, reading the user back instead", async () => {
    queryOne.mockResolvedValueOnce(userRow);

    const user = await updateUserCountry(7, null);

    expect(query).not.toHaveBeenCalled();
    expect(user?.country).toBe("IL");
  });

  it("swallows a missing-column error (pre sql/030) and returns the unchanged user", async () => {
    query.mockRejectedValueOnce({ code: "42703" });
    queryOne.mockResolvedValueOnce(userRow);

    await expect(updateUserCountry(7, "US")).resolves.toMatchObject({ id: 7 });
  });
});
