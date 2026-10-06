import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRouteVideoFiles,
  resolveRouteVideoPath,
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
