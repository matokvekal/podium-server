// Turning an admin's upload into a stored ride cover: validate what the bytes really are, then
// re-encode them to the one fixed shape every ride cover uses.
//
// Nothing the admin's browser says is trusted — not Content-Type, not a filename (this path
// never receives one). The format is decided by the magic bytes (sniffFormat, same authority
// lib/image-inspect.ts uses for avatar/cover), not by what was declared.
//
// This is deliberately NOT lib/image-inspect.ts: that module's entire point is to NEVER
// transcode (an animated GIF must stay animated). A ride cover has the opposite requirement —
// every upload, whatever its original size or shape, becomes the exact same WebP rectangle — so
// this is the one place in the server that runs images through sharp.

import sharp from "sharp";
import {
  RIDE_COVER_HEIGHT,
  RIDE_COVER_WIDTH,
  RIDE_IMAGE_UPLOAD_MAX_BYTES,
  RIDE_IMAGE_UPLOAD_MIME_TYPES,
} from "../config/ride-image-uploads.js";
import { ApiError } from "./api-error.js";
import { sniffFormat } from "./image-inspect.js";

const ALLOWED_MIME_SET = new Set<string>(RIDE_IMAGE_UPLOAD_MIME_TYPES);

export interface ProcessedRideImage {
  webp: Buffer;
  width: number;
  height: number;
}

/**
 * Validate then re-encode. Throws a 4xx (never a 500) for anything a real admin upload would
 * not produce — an oversized file, a file that is not actually a JPEG/PNG/WebP whatever it
 * claims to be, or one sharp itself cannot decode.
 */
export async function processRideImageUpload(bytes: Buffer): Promise<ProcessedRideImage> {
  if (bytes.length === 0) {
    throw new ApiError(400, "The upload was empty");
  }
  if (bytes.length > RIDE_IMAGE_UPLOAD_MAX_BYTES) {
    throw new ApiError(
      413,
      `That image is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB. The limit is ` +
        `${(RIDE_IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
    );
  }

  // What it actually is — never the declared Content-Type. GIF is a real signature sniffFormat
  // recognises but is not in RIDE_IMAGE_UPLOAD_MIME_TYPES, so it is refused here exactly like an
  // unrecognised format.
  const format = sniffFormat(bytes);
  const mime = format ? { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[format] : null;
  if (!format || !mime || !ALLOWED_MIME_SET.has(mime)) {
    throw new ApiError(415, "That file is not a JPEG, PNG or WebP image, whatever it is named or declared as");
  }

  try {
    const webp = await sharp(bytes)
      .rotate() // honour EXIF orientation before cropping, then the metadata is dropped below
      .resize(RIDE_COVER_WIDTH, RIDE_COVER_HEIGHT, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
    return { webp, width: RIDE_COVER_WIDTH, height: RIDE_COVER_HEIGHT };
  } catch {
    // sharp throws on a malformed/truncated file that nonetheless passed the magic-byte sniff.
    throw new ApiError(400, "That image is damaged or could not be read");
  }
}
