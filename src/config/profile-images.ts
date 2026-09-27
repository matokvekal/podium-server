// The operator-managed profile-image gallery — a folder of photos added and removed BY HAND
// (env.PROFILE_IMAGES_DIR), never through the app. This is the deliberate opposite of
// config/user-image-presets.ts: that registry is a compiled array because the art ships WITH
// the code; this one is a live directory scan because a new picture must become selectable, and
// a deleted one must disappear, with no code change and no deploy — see gilad/deployment.md.
//
// A gallery key is the bare filename and nothing else — never a path, never a URL. It is what
// gets stored in users.avatar_value when avatar_type = 'gallery' (config/user-images.ts).
//
// V1 is avatar-only: nothing here is wired into the cover chain, and USER_IMAGE_SOURCES'
// "gallery" value is only ever written by the avatar write path (services/user-image.service.ts).

import { readdir } from "node:fs/promises";
import { env } from "./env.js";
import { logger } from "../lib/logger.js";

/** Deliberately narrower than upload's IMAGE_FORMATS (config/user-images.ts) — curated photos
 *  only, no GIF, no SVG. Matches the security requirement: an explicit allow-list, not "whatever
 *  the folder happens to contain". */
const PROFILE_IMAGE_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg"];

/** Served by express.static in dev, by nginx directly in production — same split as
 *  PRESET_URL_PREFIX / UPLOADS_URL_PREFIX. See app.ts and gilad/deployment.md. */
export const PROFILE_IMAGES_URL_PREFIX = "/public-app-images";

export interface ProfileImage {
  /** The bare filename, stable for as long as the file exists — see the header. */
  key: string;
  url: string;
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return PROFILE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Short cache so an open picker, or several avatar-selection requests in a row, do not each
 * trigger their own directory scan — while a file an operator just copied in or deleted still
 * shows up within one TTL window, no restart required. This is the ONLY filesystem read this
 * feature ever does; resolving an already-stored avatar_value to a URL (lib/user-images.ts)
 * never touches disk, by design (see the "no per-ride scan" rule in the feature plan).
 */
const CACHE_TTL_MS = 30_000;
let cache: { keys: Set<string>; expiresAt: number } | null = null;

async function scan(): Promise<Set<string>> {
  try {
    const names = await readdir(env.PROFILE_IMAGES_DIR);
    return new Set(names.filter((name) => !name.startsWith(".") && hasAllowedExtension(name)));
  } catch (err) {
    // A missing or unreadable folder is an operator setup problem (see PROFILE_IMAGES_DIR in
    // config/env.ts), not a reason to fail every catalog request — an empty gallery is a valid,
    // if unhelpful, answer.
    logger.warn(
      { err: (err as Error).message, dir: env.PROFILE_IMAGES_DIR },
      "could not read PROFILE_IMAGES_DIR — the profile-image gallery is empty",
    );
    return new Set();
  }
}

async function currentKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.keys;
  const keys = await scan();
  cache = { keys, expiresAt: now + CACHE_TTL_MS };
  return keys;
}

export function profileImagePublicUrl(key: string): string {
  return `${env.PUBLIC_BASE_URL}${PROFILE_IMAGES_URL_PREFIX}/${key}`;
}

/** The catalog, sorted for a stable picker order. Re-scans (subject to the cache above) on
 *  every call — this is the ONE place that is allowed to, since it only runs when a rider
 *  actually opens the picker (GET /api/v1/profile-images), never on a ride or participant read. */
export async function listProfileImages(): Promise<ProfileImage[]> {
  const keys = [...(await currentKeys())].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => ({ key, url: profileImagePublicUrl(key) }));
}

/**
 * Is this filename one the gallery currently publishes? Checked against the LIVE listing, not
 * a compiled one — this is what makes a deleted file stop being selectable the moment it is
 * gone, with no registry to fall out of step. Rejects anything that is not a bare filename
 * (a path segment, a traversal attempt, a URL) before it would even reach the filesystem check.
 */
export async function isProfileImageKey(value: string): Promise<boolean> {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  if (!hasAllowedExtension(value)) return false;
  const keys = await currentKeys();
  return keys.has(value);
}
