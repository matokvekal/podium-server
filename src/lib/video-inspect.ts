// Deciding whether an uploaded body is a video container we will store, by its magic bytes only —
// the same rule lib/image-inspect.ts follows for pictures: the Content-Type header and any
// filename are ignored. Nothing is decoded or transcoded; this reads and rules.
//
//   MP4 / MOV   "ftyp" at offset 4 (ISO base media file). The brand at offset 8 tells QuickTime
//               ("qt  ") apart from MP4 — only for the stored extension; both play in browsers
//               that support the codec inside.
//   WebM        EBML header 1A 45 DF A3 (Matroska family).

import { formatMb } from "../config/ride-image-uploads.js";
import { ROUTE_VIDEO_MAX_BYTES, type RouteVideoExt } from "../config/route-videos.js";
import { ApiError } from "./api-error.js";

export interface InspectedVideo {
  ext: RouteVideoExt;
  bytes: number;
}

export function detectVideoExt(buf: Buffer): RouteVideoExt | null {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    return buf.toString("latin1", 8, 12) === "qt  " ? "mov" : "mp4";
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "webm";
  }
  return null;
}

export function inspectVideo(body: unknown): InspectedVideo {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ApiError(
      400,
      "Send the video file as the request body (video/mp4, video/webm or video/quicktime)",
    );
  }
  if (body.length > ROUTE_VIDEO_MAX_BYTES) {
    throw new ApiError(413, `Video is too large — max ${formatMb(ROUTE_VIDEO_MAX_BYTES)}`);
  }
  const ext = detectVideoExt(body);
  if (!ext) throw new ApiError(415, "Unsupported video — use MP4, MOV or WebM");
  return { ext, bytes: body.length };
}
