import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRouteVideoFiles,
  ensureRouteVideosRoot,
  resolveRouteVideoPath,
  routeVideoFileExists,
  storeRouteVideo,
} from "./route-video-storage.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "route-videos-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("route-video storage", () => {
  it("names the file after the track id", async () => {
    await storeRouteVideo(42, "mp4", Buffer.from("v1"), root);
    expect(await readdir(root)).toEqual(["42.mp4"]);
    expect(resolveRouteVideoPath(42, "mp4", root)).toBe(path.join(root, "42.mp4"));
  });

  it("a replace overwrites in place and drops the old extension", async () => {
    await storeRouteVideo(7, "mov", Buffer.from("old"), root);
    await storeRouteVideo(7, "mp4", Buffer.from("new"), root);
    expect(await readdir(root)).toEqual(["7.mp4"]);
    expect((await readFile(path.join(root, "7.mp4"))).toString()).toBe("new");
  });

  it("delete removes every extension for that track only", async () => {
    await storeRouteVideo(1, "webm", Buffer.from("a"), root);
    await storeRouteVideo(2, "mp4", Buffer.from("b"), root);
    await deleteRouteVideoFiles(1, root);
    expect(await readdir(root)).toEqual(["2.mp4"]);
  });

  it("refuses a bad id and 503s when the feature is not configured", () => {
    expect(() => resolveRouteVideoPath(0, "mp4", root)).toThrow();
    expect(() => resolveRouteVideoPath(1.5, "mp4", root)).toThrow();
    expect(() => resolveRouteVideoPath(1, "exe" as "mp4", root)).toThrow();
    expect(() => resolveRouteVideoPath(1, "mp4", null)).toThrow(
      expect.objectContaining({ status: 503 }),
    );
  });
});

describe("fallback: the video folder is missing, broken or unset", () => {
  it("boot check creates a missing folder", async () => {
    await expect(ensureRouteVideosRoot(path.join(root, "new", "dir"))).resolves.toBe(true);
  });

  it("boot check on an unusable path warns and returns false — never throws", async () => {
    const file = path.join(root, "not-a-dir");
    await writeFile(file, "x");
    await expect(ensureRouteVideosRoot(path.join(file, "videos"))).resolves.toBe(false);
  });

  it("boot check with ROUTE_VIDEOS_DIR unset is a no-op", async () => {
    await expect(ensureRouteVideosRoot(null)).resolves.toBe(false);
  });

  it("a write into an unusable folder rejects (the upload fails alone)", async () => {
    const file = path.join(root, "not-a-dir");
    await writeFile(file, "x");
    await expect(
      storeRouteVideo(1, "mp4", Buffer.from("v"), path.join(file, "videos")),
    ).rejects.toThrow();
  });

  it("deleting files for a track that has none, or with no folder configured, is fine", async () => {
    await expect(deleteRouteVideoFiles(99, root)).resolves.toBeUndefined();
    await expect(deleteRouteVideoFiles(99, null)).resolves.toBeUndefined();
    await expect(deleteRouteVideoFiles(99, path.join(root, "nope"))).resolves.toBeUndefined();
  });
});

describe("routeVideoFileExists", () => {
  it("true only for a real non-empty file; never throws", async () => {
    await storeRouteVideo(3, "mp4", Buffer.from("v"), root);
    await expect(routeVideoFileExists(3, "mp4", root)).resolves.toBe(true);
    await expect(routeVideoFileExists(3, "webm", root)).resolves.toBe(false);
    await writeFile(path.join(root, "4.mp4"), "");
    await expect(routeVideoFileExists(4, "mp4", root)).resolves.toBe(false);
    await expect(routeVideoFileExists(3, "mp4", null)).resolves.toBe(false);
    await expect(routeVideoFileExists(-1, "mp4", root)).resolves.toBe(false);
  });
});
