// A track's flyover video (sql/058-route-videos.sql) — one per route, stored as
// "{routeId}.{ext}" under ROUTE_VIDEOS_DIR (lib/route-video-storage.ts).
//
// Who may do what:
//   upload / replace / delete — the track's owner only (routes.owner_id). A creator whose ride
//                               reuses someone else's track sees the video but cannot change it.
//   watch                     — any logged-in rider who can reach the track: it is published, it
//                               is theirs, or some ride uses it (a ride's page is where the button
//                               lives). Guests never get the file — the route requires auth.

import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import { ROUTE_VIDEO_CONTENT_TYPE, ROUTE_VIDEO_MAX_DURATION_S } from "../config/route-videos.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import {
  deleteRouteVideoFiles,
  resolveRouteVideoPath,
  storeRouteVideo,
} from "../lib/route-video-storage.js";
import { inspectVideo } from "../lib/video-inspect.js";
import { selectRouteAccess } from "../queries/routeGpx.queries.js";
import {
  deleteRouteVideoRow,
  isRouteAttachedToEvent,
  type RouteVideoMeta,
  selectRouteVideo,
  upsertRouteVideo,
} from "../queries/routeVideo.queries.js";

/** The public shape — what the ride page needs to draw the button. Never the file location. */
export interface RouteVideoSummary {
  durationS: number | null;
  updatedAt: string;
}

export function toRouteVideoSummary(meta: RouteVideoMeta | null): RouteVideoSummary | null {
  return meta ? { durationS: meta.durationS, updatedAt: meta.updatedAt.toISOString() } : null;
}

/** Metadata for a route's video, or null. Null too when the feature is off on this server, so the
 *  client never shows a button for a file it could not fetch. */
export async function getRouteVideoSummary(routeId: number): Promise<RouteVideoSummary | null> {
  if (!env.ROUTE_VIDEOS_DIR) return null;
  return toRouteVideoSummary(await selectRouteVideo(routeId));
}

/** Browser-measured duration, display only: anything not a sane whole number of seconds is null. */
export function normalizeDuration(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const s = Math.round(n);
  return s >= 1 && s <= ROUTE_VIDEO_MAX_DURATION_S ? s : null;
}

async function assertTrackOwner(routeId: number, userId: number): Promise<void> {
  const access = await selectRouteAccess(routeId);
  if (!access) throw new ApiError(404, "Route not found");
  if (access.ownerId !== userId) {
    throw new ApiError(403, "Only the track's owner can change its video");
  }
}

export async function uploadRouteVideo(
  routeId: number,
  userId: number,
  body: unknown,
  rawDuration: unknown,
): Promise<RouteVideoSummary> {
  if (!env.ROUTE_VIDEOS_DIR) throw new ApiError(503, "Track videos are not enabled on this server");
  await assertTrackOwner(routeId, userId);
  const video = inspectVideo(body);
  await storeRouteVideo(routeId, video.ext, body as Buffer);
  const meta = await upsertRouteVideo(routeId, {
    ext: video.ext,
    byteLength: video.bytes,
    durationS: normalizeDuration(rawDuration),
  });
  logger.info({ routeId, userId, ext: video.ext, bytes: video.bytes }, "route video stored");
  return toRouteVideoSummary(meta) as RouteVideoSummary;
}

export async function removeRouteVideo(routeId: number, userId: number): Promise<void> {
  await assertTrackOwner(routeId, userId);
  // Row first, then the file: a failed unlink leaves an orphan file, never a row pointing at
  // nothing (the same order lib/ride-image-storage.ts's delete documents).
  await deleteRouteVideoRow(routeId);
  await deleteRouteVideoFiles(routeId);
}

/** Called when a track itself is deleted. Best-effort — never blocks the route delete. */
export async function cleanupRouteVideo(routeId: number): Promise<void> {
  try {
    await deleteRouteVideoRow(routeId);
    await deleteRouteVideoFiles(routeId);
  } catch (err) {
    logger.warn(
      { routeId, err: (err as Error).message },
      "could not clean up a deleted route's video",
    );
  }
}

export interface RouteVideoFile {
  content: Buffer;
  contentType: string;
  etag: string;
}

export async function getRouteVideoForViewer(
  routeId: number,
  viewerId: number,
): Promise<RouteVideoFile | null> {
  if (!env.ROUTE_VIDEOS_DIR) return null;
  const access = await selectRouteAccess(routeId);
  if (!access) throw new ApiError(404, "Route not found");
  const allowed =
    access.isPublic || access.ownerId === viewerId || (await isRouteAttachedToEvent(routeId));
  if (!allowed) throw new ApiError(404, "Route not found");

  const meta = await selectRouteVideo(routeId);
  if (!meta) return null;
  let content: Buffer;
  try {
    content = await readFile(resolveRouteVideoPath(routeId, meta.ext));
  } catch (err) {
    logger.warn({ routeId, err: (err as Error).message }, "route video row has no readable file");
    return null;
  }
  return {
    content,
    contentType: ROUTE_VIDEO_CONTENT_TYPE[meta.ext],
    etag: `"rv-${routeId}-${meta.updatedAt.getTime()}"`,
  };
}
