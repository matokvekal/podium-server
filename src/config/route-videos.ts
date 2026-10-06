// Limits and shape for a track-owner "flyover" video upload (sql/058-route-videos.sql).
// The bytes are stored untouched — no transcoding on this server — so the rule is simply: one of
// these containers (checked by magic bytes, lib/video-inspect.ts) and no bigger than the ceiling.

/** Content-Types app.ts hands to express.raw for PUT /api/v1/routes/:routeId/video. The header
 *  only routes the body; the stored format is whatever the bytes say. */
export const ROUTE_VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;

/** Hard ceiling, enforced by express.raw before the body is read AND again on the buffer. */
export const ROUTE_VIDEO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** What the uploader's browser measured — display only. Anything outside this is dropped to null. */
export const ROUTE_VIDEO_MAX_DURATION_S = 600;

export type RouteVideoExt = "mp4" | "webm" | "mov";

export const ROUTE_VIDEO_CONTENT_TYPE: Record<RouteVideoExt, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
