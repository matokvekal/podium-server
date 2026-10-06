// The only module that touches the track-video filesystem (sql/058-route-videos.sql). Same split
// as lib/ride-image-storage.ts: everything else deals in a route id + extension and never learns
// where the file actually lives.
//
// The file name is "{routeId}.{ext}" — the track id IS the name, so a track has exactly one
// video and a replace overwrites it. Both parts are ours (a positive integer id and an extension
// chosen from the detected container), never anything the request sent. Because the URL does not
// change on replace, the read endpoint sends an ETag, never the long immutable cache the
// ride-image files get.

import { constants } from "node:fs";
import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import type { RouteVideoExt } from "../config/route-videos.js";
import { ApiError } from "./api-error.js";
import { logger } from "./logger.js";

const EXTS: readonly RouteVideoExt[] = ["mp4", "webm", "mov"];

/** Resolve a route's video file, refusing anything that escapes the root (belt-and-braces: the
 *  id is a validated integer, but a drifted value must still fail closed). */
export function resolveRouteVideoPath(
  routeId: number,
  ext: RouteVideoExt,
  root: string | null = env.ROUTE_VIDEOS_DIR,
): string {
  if (!root) throw new ApiError(503, "Track videos are not enabled on this server");
  if (!Number.isSafeInteger(routeId) || routeId <= 0 || !EXTS.includes(ext)) {
    throw new Error("invalid route-video reference");
  }
  const resolved = path.resolve(root, `${routeId}.${ext}`);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("route-video path escapes the upload root");
  }
  return resolved;
}

/**
 * Write the bytes as "{routeId}.{ext}". Written to a temp name first and renamed, so a reader
 * never sees half a file and a failed write leaves the previous video intact. Any other-extension
 * file for the same route (a .mov replaced by an .mp4) is removed afterwards.
 */
export async function storeRouteVideo(
  routeId: number,
  ext: RouteVideoExt,
  bytes: Buffer,
  root: string | null = env.ROUTE_VIDEOS_DIR,
): Promise<void> {
  const target = resolveRouteVideoPath(routeId, ext, root);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  for (const other of EXTS) {
    if (other !== ext) await removeQuietly(resolveRouteVideoPath(routeId, other, root));
  }
}

/** True only for a real, non-empty file. Never throws — a bad reference is simply "no file". */
export async function routeVideoFileExists(
  routeId: number,
  ext: RouteVideoExt,
  root: string | null = env.ROUTE_VIDEOS_DIR,
): Promise<boolean> {
  try {
    const s = await stat(resolveRouteVideoPath(routeId, ext, root));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** Best-effort delete of every extension for this route — called after the DB row is gone. */
export async function deleteRouteVideoFiles(
  routeId: number,
  root: string | null = env.ROUTE_VIDEOS_DIR,
): Promise<void> {
  if (!root) return;
  for (const ext of EXTS) await removeQuietly(resolveRouteVideoPath(routeId, ext, root));
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "could not remove a route-video file");
  }
}

/**
 * Checks the root at boot so a misconfigured path is a loud log line, not a rider's failed
 * upload. NEVER throws — a missing or unwritable folder must not stop the server; it only means
 * video uploads will fail (each with its own error) until the folder is fixed. Returns whether
 * the folder is usable, for the log and for tests. No-op (false) when ROUTE_VIDEOS_DIR is unset.
 */
export async function ensureRouteVideosRoot(
  root: string | null = env.ROUTE_VIDEOS_DIR,
): Promise<boolean> {
  if (!root) return false;
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    return true;
  } catch (err) {
    logger.warn(
      { root, err: (err as Error).message },
      "ROUTE_VIDEOS_DIR is missing or not writable — track video uploads will fail; everything else is unaffected",
    );
    return false;
  }
}
