// Deciding whether a pile of bytes is an image we will store, and what it actually is.
//
// Nothing the client says is believed here. The Content-Type header, any filename and any
// extension are all ignored: the format is whatever the magic bytes say, and the dimensions
// are whatever the header says. A .jpg full of shell script and a PNG announced as
// image/jpeg both fail on the same check.
//
// The bytes are never modified. This module reads and rules; it does not transcode. That is
// the whole reason there is no sharp in this project: re-encoding a GIF would quietly turn
// an animation into a single frame, and the rider would have no way to tell.

import { imageSize } from "image-size";
import {
  formatKb,
  IMAGE_FORMATS,
  type ImageFormat,
  USER_IMAGE_RULES,
  type UserImageKind,
} from "../config/user-images.js";
import { ApiError } from "./api-error.js";

export interface InspectedImage {
  format: ImageFormat;
  /** The extension WE will use, derived from the format we detected. */
  ext: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * File signatures. Short and exact — this is the authority on what the file is.
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   GIF   "GIF87a" / "GIF89a"
 *   WebP  "RIFF" .... "WEBP"   (a RIFF container whose form type is WEBP)
 */
function sniffFormat(bytes: Buffer): ImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/** image-size names formats slightly differently from us; map before cross-checking. */
function normalizeDetectedType(type: string | undefined): ImageFormat | null {
  switch (type) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "gif":
      return "gif";
    case "webp":
      return "webp";
    default:
      return null;
  }
}

/**
 * Validate an upload, in this order, stopping at the first failure:
 *
 *   1. byte size        — cheapest check first, and the one that bounds all the others
 *   2. magic bytes      — what the file really is
 *   3. dimensions       — read from the header by image-size
 *   4. format + shape   — is this allowed, and is it roughly the right size
 *
 * The caller then persists the ORIGINAL buffer. Every failure is a 4xx describing the actual
 * limit; nothing here can produce a 500 for a merely bad upload.
 */
export function inspectImage(bytes: Buffer, kind: UserImageKind): InspectedImage {
  const rule = USER_IMAGE_RULES[kind];

  // 1. Size. express.raw already refused anything past this at the transport, but that guard
  //    belongs to the HTTP layer; this one belongs to the rule and holds for any caller.
  if (bytes.length === 0) {
    throw new ApiError(400, `The ${kind} upload was empty`);
  }
  if (bytes.length > rule.maxBytes) {
    throw new ApiError(
      413,
      `That ${kind} is ${formatKb(bytes.length)}. The limit is ${formatKb(rule.maxBytes)}.`,
    );
  }

  // 2. What it actually is.
  const format = sniffFormat(bytes);
  if (!format) {
    throw new ApiError(
      415,
      "That file is not a JPEG, PNG, WebP or GIF image, whatever it is named or declared as",
    );
  }

  // 3. Dimensions, from the header.
  let width: number;
  let height: number;
  let detected: ImageFormat | null;
  try {
    const size = imageSize(bytes);
    width = size.width;
    height = size.height;
    detected = normalizeDetectedType(size.type);
  } catch {
    throw new ApiError(400, `That ${kind} is a damaged or unreadable ${format.toUpperCase()} file`);
  }

  // A file whose signature and whose parsed structure disagree is malformed or deliberately
  // confusing. Either way we are not storing it.
  if (detected !== null && detected !== format) {
    throw new ApiError(400, "That image file is malformed — its header and its contents disagree");
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ApiError(400, `That ${kind} reports no usable dimensions`);
  }

  // 4. The rules for this kind of image.
  if (
    width < rule.minWidth ||
    height < rule.minHeight ||
    width > rule.maxWidth ||
    height > rule.maxHeight
  ) {
    throw new ApiError(
      400,
      `That ${kind} is ${width}x${height}. It must be between ${rule.minWidth}x${rule.minHeight} ` +
        `and ${rule.maxWidth}x${rule.maxHeight} (about ${rule.intendedSize} works best).`,
    );
  }

  const aspect = width / height;
  if (aspect < rule.minAspect || aspect > rule.maxAspect) {
    throw new ApiError(
      400,
      `That ${kind} is the wrong shape at ${width}x${height} — ` +
        `it should be about ${rule.intendedSize}.`,
    );
  }

  return {
    format,
    ext: IMAGE_FORMATS[format].ext,
    mime: IMAGE_FORMATS[format].mime,
    width,
    height,
    bytes: bytes.length,
  };
}
