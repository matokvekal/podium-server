// processRideImageUpload is where an admin's ride-cover upload actually gets validated and
// re-encoded — see the file's header for why this is not lib/image-inspect.ts. These tests pin
// the security-relevant behavior: nothing is trusted about what the bytes claim to be, only
// what sniffFormat finds, and every rejection is a 4xx.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  RIDE_COVER_HEIGHT,
  RIDE_COVER_WIDTH,
  RIDE_IMAGE_UPLOAD_MAX_BYTES,
} from "../config/ride-image-uploads.js";
import { ApiError } from "./api-error.js";
import { processRideImageUpload } from "./ride-image-process.js";

/** A real, tiny, decodable PNG — not a fake header. Wide and short on purpose, so a resize to
 *  RIDE_COVER_WIDTH x RIDE_COVER_HEIGHT via `fit: cover` genuinely has to crop it, not just
 *  scale it, exercising the same path a real photo would. */
async function realPng(width = 800, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe("processRideImageUpload", () => {
  it("resizes and crops a real upload to the fixed ride-cover shape, as WebP", async () => {
    const png = await realPng();
    const result = await processRideImageUpload(png);
    expect(result.width).toBe(RIDE_COVER_WIDTH);
    expect(result.height).toBe(RIDE_COVER_HEIGHT);

    // Prove it really is WebP and really is that shape — not just what the function claims.
    const meta = await sharp(result.webp).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(RIDE_COVER_WIDTH);
    expect(meta.height).toBe(RIDE_COVER_HEIGHT);
  });

  it("refuses an empty upload", async () => {
    await expect(processRideImageUpload(Buffer.alloc(0))).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<ApiError>);
  });

  it("refuses a file over the byte limit before ever decoding it", async () => {
    const oversized = Buffer.alloc(RIDE_IMAGE_UPLOAD_MAX_BYTES + 1, 0);
    await expect(processRideImageUpload(oversized)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a file that is not an image, whatever it is named or declared as", async () => {
    const notAnImage = Buffer.from("<html><body>not an image</body></html>");
    await expect(processRideImageUpload(notAnImage)).rejects.toMatchObject({ status: 415 });
  });

  it("refuses a GIF — real signature, but not an allowed ride-cover format", async () => {
    const gifHeader = Buffer.concat([
      Buffer.from("GIF89a", "latin1"),
      Buffer.alloc(20), // enough bytes that this is not merely "too short to sniff"
    ]);
    await expect(processRideImageUpload(gifHeader)).rejects.toMatchObject({ status: 415 });
  });

  it("refuses a PNG signature glued to garbage — a real header, not a real file", async () => {
    // Passes sniffFormat (the 8-byte PNG magic number is genuine) but sharp cannot decode what
    // follows — must fail as a damaged file, not crash the request.
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("this is not real PNG chunk data at all, just noise to fail decoding"),
    ]);
    await expect(processRideImageUpload(fakePng)).rejects.toMatchObject({ status: 400 });
  });

  it("accepts JPEG and WebP inputs too, not only PNG", async () => {
    const jpeg = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .jpeg()
      .toBuffer();
    const jpegResult = await processRideImageUpload(jpeg);
    expect(jpegResult.width).toBe(RIDE_COVER_WIDTH);

    const webp = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .webp()
      .toBuffer();
    const webpResult = await processRideImageUpload(webp);
    expect(webpResult.width).toBe(RIDE_COVER_WIDTH);
  });
});
