// A database without sql/058 (no route_videos table) must read as "no video" and let deletes
// through — the pool is mocked to answer the way Postgres does (42P01 = undefined_table).

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryOne = vi.fn();
const execute = vi.fn();
vi.mock("../db/pool.js", () => ({
  queryOne: (...a: unknown[]) => queryOne(...a),
  execute: (...a: unknown[]) => execute(...a),
}));

const { deleteRouteVideoRow, routeVideosTableExists, selectRouteVideo } = await import(
  "./routeVideo.queries.js"
);

const missingTable = Object.assign(new Error('relation "route_videos" does not exist'), {
  code: "42P01",
});

beforeEach(() => {
  queryOne.mockReset();
  execute.mockReset();
});

describe("route_videos missing (sql/058 not run)", () => {
  it("selectRouteVideo → null", async () => {
    queryOne.mockRejectedValue(missingTable);
    await expect(selectRouteVideo(5)).resolves.toBeNull();
  });

  it("deleteRouteVideoRow → nothing to delete, no error", async () => {
    execute.mockRejectedValue(missingTable);
    await expect(deleteRouteVideoRow(5)).resolves.toBeUndefined();
  });

  it("routeVideosTableExists reports it", async () => {
    queryOne.mockResolvedValue({ exists: false });
    await expect(routeVideosTableExists()).resolves.toBe(false);
  });
});

describe("other DB errors are not hidden by the query layer", () => {
  it("rethrows (the service decides what that means)", async () => {
    queryOne.mockRejectedValue(new Error("connection reset"));
    await expect(selectRouteVideo(5)).rejects.toThrow("connection reset");
    execute.mockRejectedValue(new Error("connection reset"));
    await expect(deleteRouteVideoRow(5)).rejects.toThrow("connection reset");
  });
});
