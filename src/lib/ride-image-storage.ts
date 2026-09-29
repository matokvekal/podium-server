// The only module that touches the ride-image upload filesystem. Everything else deals in the
// bare filename stored in ride_images.file_name and never learns where it actually lives — same
// split as lib/user-image-storage.ts, one level simpler because these are not per-user: every
// upload lives flat under RIDE_IMAGES_DIR, since a ride cover is shared app-wide art, not
// something one rider owns.

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "./api-error.js";
import { logger } from "./logger.js";

/** URL prefix uploaded ride covers are served under. Deliberately under /api/: production nginx
 *  already proxies /api/ to this server, so no nginx change is needed (a bare /ride-image-uploads
 *  path is answered by the SPA's index.html there — measured 2026-09-29). Served by express.static
 *  in app.ts, mounted BEFORE the rate limiter so a page of cards is not counted against it. */
export const RIDE_IMAGE_UPLOADS_URL_PREFIX = "/api/v1/ride-image-files";

/** Always a bare filename — never a path, never a URL. Stored in ride_images.file_name. */
export type RideImageFileName = string;

/**
 * Resolve a stored filename to a real path, refusing anything that escapes the upload root.
 * Belt-and-braces the same way resolveUploadPath is in user-image-storage.ts: no client-
 * supplied string reaches this today (the filename is generated here, never accepted from a
 * request), but a stored value that somehow drifted must still fail closed rather than read or
 * delete outside the tree.
 *
 * Only ever reached once a file has actually been stored (storeUpload's own null check is the
 * one gate — see below), so RIDE_IMAGES_DIR being configured is already guaranteed here.
 */
export function resolveRideImagePath(fileName: RideImageFileName): string {
  const root = env.RIDE_IMAGES_DIR;
  if (!root) throw new Error("RIDE_IMAGES_DIR is not configured");
  const resolved = path.resolve(root, fileName);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("ride-image filename escapes the upload root");
  }
  return resolved;
}

/** The URL an uploaded ride cover is fetched from, as a path on the API's own origin
 *  (`/api/v1/ride-image-files/<file>`). Deliberately NOT prefixed with PUBLIC_BASE_URL: in
 *  production the site and API share one origin, so a bare path always works, whereas a
 *  misconfigured/http/localhost PUBLIC_BASE_URL made uploaded covers silently fail to load.
 *  The client prefixes the API origin itself when it is served from a different one (dev). */
export function rideImagePublicUrl(fileName: RideImageFileName): string {
  return `${RIDE_IMAGE_UPLOADS_URL_PREFIX}/${fileName}`;
}

/**
 * Write already-processed WebP bytes and return the filename to store. The name is ours end to
 * end: `{16 hex}.webp` — nothing the admin sent (an original filename, if any) participates in
 * it, so there is nothing to sanitise. The random token also means the 1-year immutable cache
 * on this prefix is safe: a re-upload is always a new URL.
 */
export async function storeRideImageUpload(webpBytes: Buffer): Promise<RideImageFileName> {
  if (!env.RIDE_IMAGES_DIR) {
    throw new ApiError(
      500,
      "Ride-image uploads are not configured on this server (RIDE_IMAGES_DIR is not set)",
    );
  }
  await mkdir(env.RIDE_IMAGES_DIR, { recursive: true });
  const fileName = `${randomBytes(8).toString("hex")}.webp`;
  await writeFile(resolveRideImagePath(fileName), webpBytes);
  return fileName;
}

/**
 * Delete an uploaded ride cover's file. Best-effort: the caller only reaches this after the DB
 * row is already gone, so a failure here leaves an orphaned file rather than a row pointing at
 * nothing — the safer of the two half-failures.
 */
export async function deleteRideImageUpload(fileName: RideImageFileName): Promise<void> {
  let target: string;
  try {
    target = resolveRideImagePath(fileName);
  } catch {
    logger.warn({ fileName }, "refusing to delete an out-of-root ride-image reference");
    return;
  }
  try {
    await rm(target, { force: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "could not remove a deleted ride-image upload");
  }
}

/** Ensures the upload root exists at boot — same reasoning as ensureUploadRoot in
 *  user-image-storage.ts. No-op when RIDE_IMAGES_DIR is not configured. */
export async function ensureRideImagesRoot(): Promise<void> {
  if (!env.RIDE_IMAGES_DIR) return;
  await mkdir(env.RIDE_IMAGES_DIR, { recursive: true });
}
