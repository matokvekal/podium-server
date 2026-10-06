// Who may change and who may watch a track's video — with the queries and the disk mocked, so the
// rules themselves are what is under test (the SQL is exercised live; see sql/058).

import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.fn();
const attached = vi.fn();
const selectVideo = vi.fn();
const upsert = vi.fn();
const deleteRow = vi.fn();
const store = vi.fn();
const deleteFiles = vi.fn();

vi.mock("../config/env.js", () => ({ env: { ROUTE_VIDEOS_DIR: "/tmp/route-videos" } }));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../queries/routeGpx.queries.js", () => ({
  selectRouteAccess: (...a: unknown[]) => access(...a),
}));
vi.mock("../queries/routeVideo.queries.js", () => ({
  isRouteAttachedToEvent: (...a: unknown[]) => attached(...a),
  selectRouteVideo: (...a: unknown[]) => selectVideo(...a),
  upsertRouteVideo: (...a: unknown[]) => upsert(...a),
  deleteRouteVideoRow: (...a: unknown[]) => deleteRow(...a),
}));
vi.mock("../lib/route-video-storage.js", () => ({
  storeRouteVideo: (...a: unknown[]) => store(...a),
  deleteRouteVideoFiles: (...a: unknown[]) => deleteFiles(...a),
  resolveRouteVideoPath: () => "/nonexistent/route-video.mp4",
}));

const { getRouteVideoForViewer, normalizeDuration, removeRouteVideo, uploadRouteVideo } =
  await import("./routeVideo.service.js");

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(16),
]);
const OWNER = 10;
const OTHER = 20;

beforeEach(() => {
  for (const f of [access, attached, selectVideo, upsert, deleteRow, store, deleteFiles]) {
    f.mockReset();
  }
  access.mockResolvedValue({ ownerId: OWNER, isPublic: false });
  upsert.mockImplementation(async (_id: number, input: object) => ({
    ...input,
    updatedAt: new Date("2026-10-06T10:00:00Z"),
  }));
});

describe("uploading a track video", () => {
  it("the owner stores it under the track id, with the measured duration", async () => {
    const out = await uploadRouteVideo(5, OWNER, mp4, "41.6");
    expect(store).toHaveBeenCalledWith(5, "mp4", mp4);
    expect(upsert).toHaveBeenCalledWith(5, { ext: "mp4", byteLength: mp4.length, durationS: 42 });
    expect(out).toEqual({ durationS: 42, updatedAt: "2026-10-06T10:00:00.000Z" });
  });

  it("anyone else gets 403 and nothing is written", async () => {
    await expect(uploadRouteVideo(5, OTHER, mp4, "10")).rejects.toMatchObject({ status: 403 });
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("an unknown track 404s; a non-video 415s before touching disk", async () => {
    access.mockResolvedValueOnce(null);
    await expect(uploadRouteVideo(5, OWNER, mp4, "10")).rejects.toMatchObject({ status: 404 });
    await expect(uploadRouteVideo(5, OWNER, Buffer.from("nope"), "10")).rejects.toMatchObject({
      status: 415,
    });
    expect(store).not.toHaveBeenCalled();
  });
});

describe("removing a track video", () => {
  it("owner only", async () => {
    await expect(removeRouteVideo(5, OTHER)).rejects.toMatchObject({ status: 403 });
    expect(deleteRow).not.toHaveBeenCalled();
    await removeRouteVideo(5, OWNER);
    expect(deleteRow).toHaveBeenCalledWith(5);
    expect(deleteFiles).toHaveBeenCalledWith(5);
  });
});

describe("who may watch", () => {
  it("a private track used by no ride is hidden from other riders", async () => {
    attached.mockResolvedValue(false);
    await expect(getRouteVideoForViewer(5, OTHER)).rejects.toMatchObject({ status: 404 });
  });

  it("a track some ride uses is open to any logged-in rider", async () => {
    attached.mockResolvedValue(true);
    selectVideo.mockResolvedValue(null);
    await expect(getRouteVideoForViewer(5, OTHER)).resolves.toBeNull();
    expect(selectVideo).toHaveBeenCalledWith(5);
  });
});

describe("normalizeDuration", () => {
  it("keeps sane whole seconds, drops the rest", () => {
    expect(normalizeDuration("42")).toBe(42);
    expect(normalizeDuration(0.4)).toBeNull();
    expect(normalizeDuration("601")).toBeNull();
    expect(normalizeDuration("abc")).toBeNull();
    expect(normalizeDuration(undefined)).toBeNull();
  });
});
