// GET /routes/:routeId/gpx (sql/042) — the ORIGINAL file, byte for byte.
//
// What is pinned here:
//   1. the bytes handed to the response are the stored Buffer itself, untouched, with the hash
//      the importer verified against
//   2. a route with no stored original answers 404 (so the client falls back to the GPX it
//      rebuilds), and that is not an error
//   3. visibility is the route's own: published, or its owner — an unpublished route is a 404,
//      never a 403 that would confirm it exists

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRouteAccess = vi.fn();
const selectRouteGpxFile = vi.fn();

vi.mock("../db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock("../queries/routeGpx.queries.js", () => ({
  selectRouteAccess: (...a: unknown[]) => selectRouteAccess(...a),
  selectRouteGpxFile: (...a: unknown[]) => selectRouteGpxFile(...a),
}));

const { getRouteGpxController } = await import("./routeLibrary.controller.js");

// Deliberately not valid-looking UTF-8 after the header: the point is that NOTHING re-encodes it.
const ORIGINAL = Buffer.concat([
  Buffer.from('<?xml version="1.0"?>\r\n<gpx creator="x">\r\n  <wpt lat="1" lon="2"/>\r\n', "utf8"),
  Buffer.from([0x00, 0xff, 0xfe, 0x80]),
  Buffer.from("\r\n</gpx>", "utf8"),
]);

function run(params: Record<string, string>, userId?: number) {
  const headers: Record<string, string> = {};
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    set(h: Record<string, string>) {
      Object.assign(headers, h);
      return res;
    },
    send(b: unknown) {
      state.body = b;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  };
  const next = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: a minimal req/res is the point of this fixture.
  return getRouteGpxController({ params, auth: userId ? { userId } : undefined } as any, res as any, next).then(
    () => ({ headers, state, next }),
  );
}

beforeEach(() => {
  selectRouteAccess.mockReset();
  selectRouteGpxFile.mockReset();
});

describe("GET /routes/:routeId/gpx", () => {
  it("sends the stored bytes untouched, with their hash and a UTF-8 file name", async () => {
    selectRouteAccess.mockResolvedValue({ ownerId: 1, isPublic: true });
    selectRouteGpxFile.mockResolvedValue({
      content: ORIGINAL,
      sha256: "ab".repeat(32),
      byteLength: ORIGINAL.length,
      filename: "סינגל כרמל.gpx",
    });

    const { headers, state } = await run({ routeId: "42" });

    expect(state.status).toBe(200);
    expect(Buffer.isBuffer(state.body)).toBe(true);
    expect((state.body as Buffer).equals(ORIGINAL)).toBe(true);
    expect(headers["Content-Length"]).toBe(String(ORIGINAL.length));
    expect(headers["X-Content-SHA256"]).toBe("ab".repeat(32));
    expect(headers["Content-Type"]).toBe("application/gpx+xml");
    expect(headers["Content-Disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("סינגל כרמל.gpx")}`,
    );
  });

  it("answers 404 when the route has no stored original", async () => {
    selectRouteAccess.mockResolvedValue({ ownerId: 1, isPublic: true });
    selectRouteGpxFile.mockResolvedValue(null);

    const { state, next } = await run({ routeId: "42" });

    expect(state.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("is a 404, not a 403, for an unpublished route asked for by a stranger or a guest", async () => {
    selectRouteAccess.mockResolvedValue({ ownerId: 1, isPublic: false });

    const stranger = await run({ routeId: "42" }, 99);
    expect(stranger.next).toHaveBeenCalledTimes(1);
    expect((stranger.next.mock.calls[0][0] as { status: number }).status).toBe(404);

    const guest = await run({ routeId: "42" });
    expect((guest.next.mock.calls[0][0] as { status: number }).status).toBe(404);
    expect(selectRouteGpxFile).not.toHaveBeenCalled();
  });

  it("lets the owner read their own unpublished route's file", async () => {
    selectRouteAccess.mockResolvedValue({ ownerId: 7, isPublic: false });
    selectRouteGpxFile.mockResolvedValue({
      content: ORIGINAL,
      sha256: "cd".repeat(32),
      byteLength: ORIGINAL.length,
      filename: null,
    });

    const { state, headers } = await run({ routeId: "42" }, 7);

    expect(state.status).toBe(200);
    expect(headers["Content-Disposition"]).toContain("route-42.gpx");
  });

  it("is a 404 for a route that does not exist", async () => {
    selectRouteAccess.mockResolvedValue(null);
    const { next } = await run({ routeId: "999" });
    expect((next.mock.calls[0][0] as { status: number }).status).toBe(404);
  });
});
