// Who may change and who may watch a track's video, and — just as important — that every failure
// of the optional video subsystem degrades to "no video" instead of breaking anything. Queries and
// disk are mocked, so the rules themselves are what is under test (the SQL is exercised live).

import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.fn();
const attached = vi.fn();
const selectVideo = vi.fn();
const upsert = vi.fn();
const deleteRow = vi.fn();
const tableExists = vi.fn();
const store = vi.fn();
const deleteFiles = vi.fn();
const fileExists = vi.fn();
const warn = vi.fn();

const envMock: { ROUTE_VIDEOS_DIR: string | null } = { ROUTE_VIDEOS_DIR: "/tmp/route-videos" };
vi.mock("../config/env.js", () => ({ env: envMock }));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("../queries/routeGpx.queries.js", () => ({
  selectRouteAccess: (...a: unknown[]) => access(...a),
}));
vi.mock("../queries/routeVideo.queries.js", () => ({
  isRouteAttachedToEvent: (...a: unknown[]) => attached(...a),
  selectRouteVideo: (...a: unknown[]) => selectVideo(...a),
  upsertRouteVideo: (...a: unknown[]) => upsert(...a),
  deleteRouteVideoRow: (...a: unknown[]) => deleteRow(...a),
  routeVideosTableExists: (...a: unknown[]) => tableExists(...a),
}));
vi.mock("../lib/route-video-storage.js", () => ({
  storeRouteVideo: (...a: unknown[]) => store(...a),
  deleteRouteVideoFiles: (...a: unknown[]) => deleteFiles(...a),
  routeVideoFileExists: (...a: unknown[]) => fileExists(...a),
  resolveRouteVideoPath: () => "/nonexistent/route-video.mp4",
}));

const {
  cleanupRouteVideo,
  getRouteVideoForViewer,
  getRouteVideoSummary,
  normalizeDuration,
  removeRouteVideo,
  uploadRouteVideo,
} = await import("./routeVideo.service.js");

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(16),
]);
const OWNER = 10;
const OTHER = 20;
const ROW = {
  ext: "mp4" as const,
  byteLength: 100,
  durationS: 42,
  updatedAt: new Date("2026-10-06T10:00:00Z"),
};

beforeEach(() => {
  for (const f of [
    access,
    attached,
    selectVideo,
    upsert,
    deleteRow,
    tableExists,
    store,
    deleteFiles,
    fileExists,
    warn,
  ]) {
    f.mockReset();
  }
  envMock.ROUTE_VIDEOS_DIR = "/tmp/route-videos";
  access.mockResolvedValue({ ownerId: OWNER, isPublic: false });
  tableExists.mockResolvedValue(true);
  fileExists.mockResolvedValue(true);
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

// ---- fail-safe: the video is optional and may never break anything else ----------------------

describe("fallback: ROUTE_VIDEOS_DIR is not configured", () => {
  beforeEach(() => {
    envMock.ROUTE_VIDEOS_DIR = null;
  });

  it("reads say 'no video' without touching the DB", async () => {
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
    await expect(getRouteVideoForViewer(5, OWNER)).resolves.toBeNull();
    expect(selectVideo).not.toHaveBeenCalled();
  });

  it("upload is simply unavailable (503), nothing is written", async () => {
    await expect(uploadRouteVideo(5, OWNER, mp4, "10")).rejects.toMatchObject({ status: 503 });
    expect(store).not.toHaveBeenCalled();
  });
});

describe("fallback: route_videos table does not exist yet", () => {
  it("upload refuses with 503 BEFORE writing a file", async () => {
    tableExists.mockResolvedValue(false);
    await expect(uploadRouteVideo(5, OWNER, mp4, "10")).rejects.toMatchObject({ status: 503 });
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("reads see no row and report no video", async () => {
    selectVideo.mockResolvedValue(null); // what selectRouteVideo answers for 42P01
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
  });
});

describe("fallback: the track has no video", () => {
  it("summary is null", async () => {
    selectVideo.mockResolvedValue(null);
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
    expect(fileExists).not.toHaveBeenCalled();
  });
});

describe("fallback: DB row exists but the file is missing", () => {
  it("summary says no video (so no button) and logs", async () => {
    selectVideo.mockResolvedValue(ROW);
    fileExists.mockResolvedValue(false);
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("the file endpoint answers null (404), never throws", async () => {
    attached.mockResolvedValue(true);
    selectVideo.mockResolvedValue(ROW);
    await expect(getRouteVideoForViewer(5, OTHER)).resolves.toBeNull();
  });

  it("with the file present the summary is reported", async () => {
    selectVideo.mockResolvedValue(ROW);
    await expect(getRouteVideoSummary(5)).resolves.toEqual({
      durationS: 42,
      updatedAt: "2026-10-06T10:00:00.000Z",
    });
  });
});

describe("fallback: the video lookup itself fails", () => {
  it("a DB error is 'no video', never an exception (GET /routes/:id must keep working)", async () => {
    selectVideo.mockRejectedValue(new Error("connection reset"));
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
    fileExists.mockRejectedValue(new Error("EIO"));
    selectVideo.mockResolvedValue(ROW);
    await expect(getRouteVideoSummary(5)).resolves.toBeNull();
  });
});

describe("fallback: upload/delete failures stay inside the video operation", () => {
  it("a disk write failure rejects the upload only, and records nothing", async () => {
    store.mockRejectedValue(new Error("EACCES"));
    await expect(uploadRouteVideo(5, OWNER, mp4, "10")).rejects.toThrow("EACCES");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("fallback: track deletion never fails because of its video", () => {
  it("cleanup swallows a DB failure and still tries the files", async () => {
    deleteRow.mockRejectedValue(new Error("db down"));
    await expect(cleanupRouteVideo(5)).resolves.toBeUndefined();
    expect(deleteFiles).toHaveBeenCalledWith(5);
    expect(warn).toHaveBeenCalled();
  });

  it("cleanup swallows a file-removal failure", async () => {
    deleteFiles.mockRejectedValue(new Error("EPERM"));
    await expect(cleanupRouteVideo(5)).resolves.toBeUndefined();
    expect(deleteRow).toHaveBeenCalledWith(5);
  });
});
