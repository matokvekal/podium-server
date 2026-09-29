// Business logic for the ride-image registry (sql/052-ride-images-registry.sql): the System
// Admin's upload/enable/disable/delete actions, and the one read every other caller needs —
// "is this key one this server currently knows about at all" — used to validate
// events.ride_image_key on create/update (services/event.service.ts).

import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { isRideImageCategory } from "../config/ride-image-uploads.js";
import { ApiError } from "../lib/api-error.js";
import { AUDIT_ACTIONS, audit } from "../lib/audit.js";
import { processRideImageUpload } from "../lib/ride-image-process.js";
import {
  deleteRideImageUpload,
  rideImagePublicUrl,
  storeRideImageUpload,
} from "../lib/ride-image-storage.js";
import {
  countEventsUsingRideImage,
  deleteRideImageRow,
  insertRideImage,
  type RideImageRow,
  selectAllRideImages,
  selectRideImageByKey,
  updateRideImageSelectable,
} from "../queries/rideImages.queries.js";

/**
 * Short cache so a busy Create/Edit Ride page (every rider, not just the admin) does not turn
 * "read the ride-image catalog" into a query per open — same reasoning and the same TTL as
 * config/profile-images.ts's directory-scan cache. An admin's add/disable/delete goes through
 * this module and invalidates it directly, so an admin action is never delayed by its own cache.
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

/** GET /api/v1/ride-images — every authenticated rider gets the full catalog (selectable or
 *  not): the Create/Edit picker filters to `selectable`, and every other render site needs the
 *  REST of it too, to resolve a ride that already wears a since-disabled key. Nothing here is
 *  sensitive — these are public image URLs — so there is no reason to shape two responses. */
export async function listRideImages(): Promise<RideImageRow[]> {
  return allRideImagesCached();
}

/** The admin table — same rows, uncached, so a just-uploaded image always shows immediately to
 *  the admin who uploaded it. */
export async function listRideImagesForAdmin(): Promise<RideImageRow[]> {
  return selectAllRideImages();
}

/**
 * Is this a key the server currently recognises — static or uploaded, selectable or not?
 * Selectable is deliberately NOT part of this check: an existing ride keeps its stored key
 * forever (sql/051/sql/052 headers), so validating a create/update must accept a disabled key
 * exactly like a selectable one — only the PICKER cares about `selectable`.
 */
export async function isKnownRideImageKey(key: string): Promise<boolean> {
  const rows = await allRideImagesCached();
  return rows.some((row) => row.key === key);
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
 * it as selectable. The generated key is random and permanent from this point on (sql/051's
 * rule) — it is never reused even if the row is later deleted.
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

export async function setRideImageSelectable(
  req: Request,
  key: string,
  selectable: boolean,
): Promise<RideImageRow> {
  const updated = await updateRideImageSelectable(key, selectable);
  if (!updated) throw new ApiError(404, `There is no ride image called "${key}"`);
  invalidateCache();

  audit(req, AUDIT_ACTIONS.RIDE_IMAGE_SELECTABLE_CHANGED, {
    entity: "ride_image",
    entityId: key,
    meta: { selectable },
  });
  return updated;
}

/**
 * Physical deletion is only ever offered for an unused upload — never for a static (build-
 * shipped) key, and never for a key any ride currently references (see sql/052's header). The
 * safe way to retire an image any ride might already be wearing is setRideImageSelectable(false).
 */
export async function deleteRideImage(req: Request, key: string): Promise<void> {
  const existing = await selectRideImageByKey(key);
  if (!existing) throw new ApiError(404, `There is no ride image called "${key}"`);

  if (existing.source === "static") {
    throw new ApiError(400, "A built-in image cannot be deleted — disable it instead");
  }

  const usageCount = await countEventsUsingRideImage(key);
  if (usageCount > 0) {
    throw new ApiError(
      409,
      `${usageCount} ride${usageCount === 1 ? "" : "s"} currently use this image — disable it instead of deleting`,
    );
  }

  await deleteRideImageRow(key);
  invalidateCache();

  if (existing.fileName) await deleteRideImageUpload(existing.fileName);

  audit(req, AUDIT_ACTIONS.RIDE_IMAGE_DELETED, {
    entity: "ride_image",
    entityId: key,
  });
}
