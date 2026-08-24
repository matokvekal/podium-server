import { describe, expect, it } from "vitest";
import { USER_IMAGE_RULES } from "../config/user-images.js";
import { animatedGif, jpeg, png, webp } from "./__fixtures__/images.js";
import { ApiError } from "./api-error.js";
import { inspectImage } from "./image-inspect.js";

/** The status a rejection came back with — every failure here must be a 4xx, never a throw
 *  that reaches the generic 500 handler. */
function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.status;
    throw err;
  }
  throw new Error("expected inspectImage to reject, but it accepted the input");
}

describe("inspectImage — accepts the four supported formats", () => {
  it("accepts a PNG avatar", () => {
    expect(inspectImage(png(256, 256), "avatar")).toMatchObject({
      format: "png",
      ext: "png",
      width: 256,
      height: 256,
    });
  });

  it("accepts a JPEG cover at the intended 1200x450", () => {
    expect(inspectImage(jpeg(1200, 450), "cover")).toMatchObject({
      format: "jpeg",
      ext: "jpg",
      width: 1200,
      height: 450,
    });
  });

  it("accepts a WebP avatar", () => {
    expect(inspectImage(webp(256, 256), "avatar")).toMatchObject({ format: "webp", ext: "webp" });
  });

  it("accepts an animated GIF avatar", () => {
    expect(inspectImage(animatedGif(256, 256), "avatar")).toMatchObject({
      format: "gif",
      ext: "gif",
    });
  });
});

describe("inspectImage — the bytes decide, not the client", () => {
  it("classifies by signature, so a fake extension or Content-Type cannot lie", () => {
    // Whatever this was announced as, it is a PNG. inspectImage never sees the request at
    // all, which is the point: there is nothing here for a client to influence.
    expect(inspectImage(png(256, 256), "avatar").ext).toBe("png");
  });

  it("rejects a text file, however it is named", () => {
    const notAnImage = Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8");
    expect(statusOf(() => inspectImage(notAnImage, "avatar"))).toBe(415);
  });

  it("rejects a file with an image extension's worth of hope and nothing else", () => {
    expect(statusOf(() => inspectImage(Buffer.from("JPEG", "utf8"), "avatar"))).toBe(415);
  });

  it("rejects an empty body", () => {
    expect(statusOf(() => inspectImage(Buffer.alloc(0), "avatar"))).toBe(400);
  });

  it("rejects a file with a valid signature but a corrupt body", () => {
    const truncated = png(256, 256).subarray(0, 12);
    expect(statusOf(() => inspectImage(truncated, "avatar"))).toBe(400);
  });
});

describe("inspectImage — size limits", () => {
  it("rejects an oversized avatar with 413", () => {
    const huge = Buffer.concat([png(256, 256), Buffer.alloc(USER_IMAGE_RULES.avatar.maxBytes)]);
    expect(statusOf(() => inspectImage(huge, "avatar"))).toBe(413);
  });

  it("rejects an oversized cover with 413", () => {
    const huge = Buffer.concat([jpeg(1200, 450), Buffer.alloc(USER_IMAGE_RULES.cover.maxBytes)]);
    expect(statusOf(() => inspectImage(huge, "cover"))).toBe(413);
  });

  it("enforces the avatar limit independently of the cover limit", () => {
    // Comfortably under the 200 KB cover ceiling, comfortably over the 50 KB avatar one.
    const between = Buffer.concat([png(256, 256), Buffer.alloc(80 * 1024)]);
    expect(statusOf(() => inspectImage(between, "avatar"))).toBe(413);
  });
});

describe("inspectImage — dimension rules", () => {
  it("rejects a tiny avatar", () => {
    expect(statusOf(() => inspectImage(png(8, 8), "avatar"))).toBe(400);
  });

  it("rejects an enormous avatar", () => {
    expect(statusOf(() => inspectImage(png(3000, 3000), "avatar"))).toBe(400);
  });

  it("rejects a wide banner submitted as an avatar", () => {
    expect(statusOf(() => inspectImage(png(1000, 200), "avatar"))).toBe(400);
  });

  it("rejects a square image submitted as a cover", () => {
    expect(statusOf(() => inspectImage(png(600, 600), "cover"))).toBe(400);
  });

  it("rejects a cover that is too small to be one", () => {
    expect(statusOf(() => inspectImage(png(200, 75), "cover"))).toBe(400);
  });

  it("accepts sizes near but not exactly the intended ones", () => {
    expect(inspectImage(png(240, 260), "avatar").width).toBe(240);
    expect(inspectImage(jpeg(1280, 480), "cover").width).toBe(1280);
  });
});

describe("inspectImage — never modifies the bytes", () => {
  it("leaves an animated GIF untouched, looping block and all", () => {
    const original = animatedGif(256, 256);
    const copy = Buffer.from(original);

    inspectImage(original, "avatar");

    // The validator only reads. If it ever re-encoded, the NETSCAPE2.0 block below — the
    // thing that makes the GIF loop — is exactly what would silently disappear.
    expect(original.equals(copy)).toBe(true);
    expect(original.includes(Buffer.from("NETSCAPE2.0", "latin1"))).toBe(true);
  });
});
