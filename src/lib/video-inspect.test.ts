import { describe, expect, it } from "vitest";
import { ROUTE_VIDEO_MAX_BYTES } from "../config/route-videos.js";
import { detectVideoExt, inspectVideo } from "./video-inspect.js";

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(16),
]);
const mov = Buffer.concat([
  Buffer.from([0, 0, 0, 0x14]),
  Buffer.from("ftypqt  "),
  Buffer.alloc(16),
]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);

describe("detectVideoExt", () => {
  it("reads the container from the bytes", () => {
    expect(detectVideoExt(mp4)).toBe("mp4");
    expect(detectVideoExt(mov)).toBe("mov");
    expect(detectVideoExt(webm)).toBe("webm");
  });

  it("refuses anything else, whatever it claims to be", () => {
    expect(detectVideoExt(Buffer.from("#!/bin/sh\necho hi\n"))).toBeNull();
    expect(
      detectVideoExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    expect(detectVideoExt(Buffer.alloc(3))).toBeNull();
  });
});

describe("inspectVideo", () => {
  it("accepts a real container and reports its size", () => {
    expect(inspectVideo(mp4)).toEqual({ ext: "mp4", bytes: mp4.length });
  });

  it("400s a missing body, 413s an oversized one, 415s a non-video", () => {
    expect(() => inspectVideo(undefined)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => inspectVideo({})).toThrow(expect.objectContaining({ status: 400 }));
    const big = Buffer.concat([mp4, Buffer.alloc(ROUTE_VIDEO_MAX_BYTES)]);
    expect(() => inspectVideo(big)).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => inspectVideo(Buffer.from("not a video at all"))).toThrow(
      expect.objectContaining({ status: 415 }),
    );
  });
});
