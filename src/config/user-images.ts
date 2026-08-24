// Limits and formats for a user's Avatar and Cover. Constants, not env vars, for the same
// reason otp.constants.ts is: they are a product decision that has to hold identically on
// every deployment, not a per-server knob. Change them here and the API, the validator and
// the body-size guard all move together.

/** The two images a user owns. Events reuse them through events.owner_id. */
export const USER_IMAGE_KINDS = ["avatar", "cover"] as const;
export type UserImageKind = (typeof USER_IMAGE_KINDS)[number];

/** Where an image came from. Stored in users.{avatar,cover}_type. */
export const USER_IMAGE_SOURCES = ["preset", "upload"] as const;
export type UserImageSource = (typeof USER_IMAGE_SOURCES)[number];

export function isUserImageSource(value: unknown): value is UserImageSource {
  return typeof value === "string" && (USER_IMAGE_SOURCES as readonly string[]).includes(value);
}

/**
 * The formats an upload may be in. The extension is ours, chosen from the bytes we sniffed —
 * never from the request — so a file can only ever be named after what it actually is.
 *
 * GIF is here on purpose and is stored byte-for-byte like every other format: nothing is
 * re-encoded, so an animated GIF stays animated. That is also why this project has no sharp.
 */
export const IMAGE_FORMATS = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
} as const;

export type ImageFormat = keyof typeof IMAGE_FORMATS;

/** Content types express.raw() will buffer on the upload routes. */
export const UPLOAD_MIME_TYPES: string[] = Object.values(IMAGE_FORMATS).map((f) => f.mime);

export interface UserImageRule {
  /** Hard server-side ceiling. The client aims lower (20 KB / 100 KB); this is what is
   *  actually enforced, twice — once by express.raw at the transport, once on the buffer. */
  maxBytes: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** Inclusive width/height ratio band. Brackets the intended shape without demanding an
   *  exact size — a 240x260 avatar or a 1280x480 cover is fine, a 4000x80 banner is not. */
  minAspect: number;
  maxAspect: number;
  /** For error messages: what the image is roughly meant to be. */
  intendedSize: string;
}

export const USER_IMAGE_RULES: Record<UserImageKind, UserImageRule> = {
  // Roughly 256x256, so square-ish: between 2:3 and 3:2.
  avatar: {
    maxBytes: 50 * 1024,
    minWidth: 64,
    maxWidth: 1024,
    minHeight: 64,
    maxHeight: 1024,
    minAspect: 1 / 1.5,
    maxAspect: 1.5,
    intendedSize: "256x256",
  },
  // Roughly 1200x450 (2.67:1), so wide: between 1.6:1 and 4.5:1.
  cover: {
    maxBytes: 200 * 1024,
    minWidth: 400,
    maxWidth: 4000,
    minHeight: 150,
    maxHeight: 2000,
    minAspect: 1.6,
    maxAspect: 4.5,
    intendedSize: "1200x450",
  },
};

/** "50 KB" — used in the 4xx messages so a rejection says what the limit actually is. */
export function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
