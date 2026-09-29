// Business logic for the ride-image registry (sql/052, sql/054): the System Admin's upload /
// replace / enable / disable / archive actions, and the reads every other caller needs.
//
// THE LIFECYCLE, in one place:
//   ACTIVE + selectable      shown in admin, offered in Create/Edit Ride
//   ACTIVE + not selectable  shown in admin, not offered for NEW selections
//   ARCHIVED                 hidden from admin, not offered — but still RESOLVES, so every ride
//                            that already stores the key keeps showing its picture
// A key is permanent and never physically removed. Selectable/archived only ever decide whether a
// key can be CHOSEN; they never decide whether an existing ride can DISPLAY it.

import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { isRideImageCategory } from "../config/ride-image-uploads.js";
import { ApiError } from "../lib/api-error.js";
import { AUDIT_ACTIONS, audit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { processRideImageUpload } from "../lib/ride-image-process.js";
import {
  deleteRideImageUpload,
  rideImagePublicUrl,
  storeRideImageUpload,
} from "../lib/ride-image-storage.js";
import {
  archiveRideImageRow,
  insertRideImage,
  RideImageLifecycleUnavailableError,
  type RideImageRow,
  replaceRideImageRow,
  selectAllRideImages,
  selectRideImageByKey,
  updateRideImageSelectable,
} from "../queries/rideImages.queries.js";

/**
 * Short cache so a busy Create/Edit Ride page (every rider, not just the admin) does not turn
 * "read the ride-image catalog" into a query per open. Every admin action goes through this
 * module and invalidates it directly, so an admin action is never delayed by its own cache.
 */
const CACHE_TTL_MS = 30_000;
let cache: { rows: RideImageRow[]; expiresAt: number } | null = null;

function invalidateCache(): void {
  cache = null;
}

async function allRideImagesCached(): Promise<RideImageRow[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.rows;
  const rows = await selectAllRideImages();
  cache = { rows, expiresAt: now + CACHE_TTL_MS };
  return rows;
}

/**
 * The URL a client should load this image from. An uploaded image is always resolved from its
 * file name (so it is served by this API, wherever the file lives), a built-in one keeps its
 * client-relative path. Once an image has been replaced (version > 1) the version is appended:
 * a device that cached the old picture under the old URL sees a different URL and downloads the
 * new one — the key, and every ride that stores it, is untouched.
 */
export function resolveRideImageUrl(row: RideImageRow): string {
  const base = row.source === "upload" && row.fileName ? rideImagePublicUrl(row.fileName) : row.url;
  return row.version > 1 ? `${base}?v=${row.version}` : base;
}

/** GET /api/v1/ride-images — every authenticated rider gets the full catalog, archived and
 *  disabled included, because every render site must be able to resolve a ride's existing key.
 *  Callers offering a CHOICE filter with `isPickable`. */
export async function listRideImages(): Promise<RideImageRow[]> {
  return allRideImagesCached();
}

/** Can this image be chosen for a NEW selection (the picker)? */
export function isPickable(row: RideImageRow): boolean {
  return row.selectable && !row.archived;
}

/** The admin table: active images only — archived ones are hidden. Uncached, so a just-uploaded
 *  or just-replaced image shows immediately. */
export async function listRideImagesForAdmin(): Promise<RideImageRow[]> {
  const rows = await selectAllRideImages();
  return rows.filter((row) => !row.archived);
}

/**
 * May a ride store this key? Used when a ride is created or edited.
 *   - a key the server does not know: no
 *   - a key that is selectable and not archived: yes
 *   - a disabled/archived key: only if the ride ALREADY stores exactly that key (an edit that
 *     leaves the picture alone resends it; that must keep working). It cannot be newly chosen.
 */
export async function assertRideImageAssignable(
  key: string,
  currentKey: string | null | undefined,
): Promise<void> {
  const row = (await allRideImagesCached()).find((r) => r.key === key);
  if (!row) throw new ApiError(400, `There is no ride image called "${key}"`);
  if (isPickable(row) || key === currentKey) return;
  throw new ApiError(400, `The ride image "${key}" is no longer available`);
}

function randomUploadKey(): string {
  return `upload-${randomBytes(8).toString("hex")}`;
}

export interface UploadRideImageInput {
  bytes: Buffer;
  label: string;
  category: string;
}

/**
 * Validate, resize/crop to the fixed ride-cover shape, convert to WebP, store it, and register
 * it as selectable. The generated key is random and permanent from this point on.
 */
export async function uploadRideImage(
  req: Request,
  input: UploadRideImageInput,
): Promise<RideImageRow> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 60) {
    throw new ApiError(400, "label must be 1-60 characters");
  }
  const category = isRideImageCategory(input.category) ? input.category : "generic";

  const processed = await processRideImageUpload(input.bytes);
  const fileName = await storeRideImageUpload(processed.webp);
  const key = randomUploadKey();

  try {
    const row = await insertRideImage({
      key,
      source: "upload",
      selectable: true,
      label,
      category,
      url: rideImagePublicUrl(fileName),
      fileName,
    });
    invalidateCache();

    audit(req, AUDIT_ACTIONS.RIDE_IMAGE_UPLOADED, {
      entity: "ride_image",
      entityId: key,
      meta: { label, category, width: processed.width, height: processed.height },
    });
    return row;
  } catch (err) {
    // The DB row is what makes the file reachable at all; if the insert failed, the file we
    // just wrote is unreferenced and must not be left behind.
    await deleteRideImageUpload(fileName);
    throw err;
  }
}

/**
 * Replace the picture behind an existing key. The key does not change, so no ride is touched;
 * the row's version goes up, which changes the URL the API resolves (resolveRideImageUrl) and
 * so busts every browser/PWA cache. Works for a built-in key too: it becomes upload-backed.
 * The previous file is kept (nothing is physically deleted).
 */
export async function replaceRideImage(
  req: Request,
  key: string,
  bytes: Buffer,
): Promise<RideImageRow> {
  const existing = await selectRideImageByKey(key);
  if (!existing || existing.archived) {
    throw new ApiError(404, `There is no ride image called "${key}"`);
  }

  const processed = await processRideImageUpload(bytes);
  const fileName = await storeRideImageUpload(processed.webp);

  try {
    const row = await replaceRideImageRow(key, { fileName, url: rideImagePublicUrl(fileName) });
    if (!row) throw new ApiError(404, `There is no ride image called "${key}"`);
    invalidateCache();

    audit(req, AUDIT_ACTIONS.RIDE_IMAGE_REPLACED, {
      entity: "ride_image",
      entityId: key,
      meta: { version: row.version, width: processed.width, height: processed.height },
    });
    return row;
  } catch (err) {
    await deleteRideImageUpload(fileName);
    throw toLifecycleError(err);
  }
}

export async function setRideImageSelectable(
  req: Request,
  key: string,
  selectable: boolean,
): Promise<RideImageRow> {
  const updated = await updateRideImageSelectable(key, selectable);
  if (!updated || updated.archived)
    throw new ApiError(404, `There is no ride image called "${key}"`);
  invalidateCache();

  audit(req, AUDIT_ACTIONS.RIDE_IMAGE_SELECTABLE_CHANGED, {
    entity: "ride_image",
    entityId: key,
    meta: { selectable },
  });
  return updated;
}

/**
 * "Delete" is an ARCHIVE. The row and file stay; the key stops being offered and disappears from
 * the admin list, and every ride that already stores it keeps displaying it.
 */
export async function archiveRideImage(req: Request, key: string): Promise<void> {
  try {
    const row = await archiveRideImageRow(key);
    if (!row) throw new ApiError(404, `There is no ride image called "${key}"`);
  } catch (err) {
    throw toLifecycleError(err);
  }
  invalidateCache();

  audit(req, AUDIT_ACTIONS.RIDE_IMAGE_DELETED, {
    entity: "ride_image",
    entityId: key,
    meta: { archived: true },
  });
}

/** sql/054 not applied yet: a clean 503 on the two actions that need it, never a crash. */
function toLifecycleError(err: unknown): unknown {
  if (err instanceof RideImageLifecycleUnavailableError) {
    logger.warn({ err: err.message }, "ride image lifecycle needs sql/054");
    return new ApiError(503, "Replace/Archive are not available until sql/054 is applied");
  }
  return err;
}
