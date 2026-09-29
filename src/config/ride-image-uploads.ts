// Limits and shape for a System-Admin ride-cover upload (sql/052-ride-images-registry.sql).
// Separate from config/user-images.ts's USER_IMAGE_RULES: a ride cover is admin-curated art,
// always re-encoded to one fixed shape, and never needs GIF (no animated ride covers) — so the
// rules here are deliberately narrower than the avatar/cover upload path.

/** No GIF: a ride cover is always resized and re-encoded (lib/ride-image-process.ts), so there
 *  is no "stays animated" guarantee to protect the way config/user-images.ts protects one. */
export const RIDE_IMAGE_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Hard server-side ceiling, checked against the raw upload before it is ever decoded. */
/** The admin panel shrinks any picture (up to 4 MB) to fit this before sending; anything larger
 *  that still arrives is refused outright, so an upload can never tie the server up. */
export const RIDE_IMAGE_UPLOAD_MAX_BYTES = 250 * 1024; // 250 KB

/** Every ride cover is resized/cropped to exactly this shape server-side, whatever the admin
 *  uploaded — matches the aspect ratio the picker's existing artwork already uses (roughly
 *  2.67:1, e.g. tikva1.webp at 917x338). `fit: cover` crops rather than letterboxes. */
export const RIDE_COVER_WIDTH = 1200;
export const RIDE_COVER_HEIGHT = 450;

/** Same category list the client picker groups by (lib/ride-images.ts's RideImageCategory) —
 *  duplicated here as a plain string union rather than imported, because this is the one place
 *  a client type would otherwise leak into the server. Kept in step by hand; a mismatch is
 *  harmless (unknownCategoryFallback below), not a break. */
export const RIDE_IMAGE_CATEGORIES = [
  "sukkot",
  "holidays",
  "road",
  "mtb",
  "gravel",
  "generic",
] as const;
export type RideImageCategory = (typeof RIDE_IMAGE_CATEGORIES)[number];

export function isRideImageCategory(value: unknown): value is RideImageCategory {
  return typeof value === "string" && (RIDE_IMAGE_CATEGORIES as readonly string[]).includes(value);
}

/** "2 MB" — for the 4xx message so a rejection states the actual limit. */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
