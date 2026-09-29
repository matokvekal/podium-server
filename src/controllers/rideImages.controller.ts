import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/api-error.js";
import { traceLog } from "../lib/trace-log.js";
import type { RideImageRow } from "../queries/rideImages.queries.js";
import {
  rideImageKeyParamSchema,
  setRideImageSelectableSchema,
  uploadRideImageQuerySchema,
} from "../schemas/rideImages.schemas.js";
import {
  archiveRideImage,
  listRideImages,
  listRideImagesForAdmin,
  replaceRideImage,
  resolveRideImageUrl,
  setRideImageSelectable,
  uploadRideImage,
} from "../services/rideImages.service.js";

/** What every caller — the picker, the admin table, a card resolving an existing ride's cover —
 *  gets for one row. `selectable` is included even on the "public" list because the picker has
 *  to filter to it and everyone else safely ignores it. */
function toPublicDto(row: RideImageRow) {
  return {
    key: row.key,
    // Versioned once replaced (services/rideImages.service.ts resolveRideImageUrl), so a cached
    // copy of the old picture is never reused.
    url: resolveRideImageUrl(row),
    label: row.label,
    category: row.category,
    // What the picker offers. An archived or disabled key is still LISTED (an existing ride must
    // resolve it) but is never `selectable`.
    selectable: row.selectable && !row.archived,
    version: row.version,
  };
}

function toAdminDto(row: RideImageRow) {
  return { ...toPublicDto(row), source: row.source, createdAt: row.createdAt.toISOString() };
}

// GET /api/v1/ride-images — public (anonymous visitors resolve public rides' covers).
export async function listRideImagesController(_req: Request, res: Response, next: NextFunction) {
  traceLog("rideImages.controller.listRideImagesController");
  try {
    const rows = await listRideImages();
    res.status(200).json({ data: rows.map(toPublicDto) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/admin/ride-images
export async function adminListRideImagesController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("rideImages.controller.adminListRideImagesController");
  try {
    const rows = await listRideImagesForAdmin();
    res.status(200).json({ data: rows.map(toAdminDto) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/admin/ride-images — raw image bytes as the body (express.raw in app.ts, same
 * shape as PUT /users/me/avatar), label/category as query params since there is nowhere else
 * for them to travel on a raw-bytes request.
 */
export async function adminUploadRideImageController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("rideImages.controller.adminUploadRideImageController");
  try {
    if (!Buffer.isBuffer(req.body)) {
      throw new ApiError(
        415,
        "Send the image as JPEG, PNG or WebP bytes with a matching Content-Type, " +
          "and label (required) / category (optional) as query params",
      );
    }
    const { label, category } = uploadRideImageQuerySchema.parse(req.query);
    const row = await uploadRideImage(req, { bytes: req.body, label, category });
    res.status(201).json({ data: toAdminDto(row) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/admin/ride-images/:key  { "selectable": boolean }
export async function adminSetSelectableController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("rideImages.controller.adminSetSelectableController");
  try {
    const key = rideImageKeyParamSchema.parse(req.params.key);
    const { selectable } = setRideImageSelectableSchema.parse(req.body);
    const row = await setRideImageSelectable(req, key, selectable);
    res.status(200).json({ data: toAdminDto(row) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/v1/admin/ride-images/:key/replace — raw image bytes; the KEY stays the same. */
export async function adminReplaceRideImageController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("rideImages.controller.adminReplaceRideImageController");
  try {
    const key = rideImageKeyParamSchema.parse(req.params.key);
    if (!Buffer.isBuffer(req.body)) {
      throw new ApiError(
        415,
        "Send the image as JPEG, PNG or WebP bytes with a matching Content-Type",
      );
    }
    const row = await replaceRideImage(req, key, req.body);
    res.status(200).json({ data: toAdminDto(row) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/admin/ride-images/:key — an ARCHIVE, never a physical delete.
export async function adminDeleteRideImageController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("rideImages.controller.adminDeleteRideImageController");
  try {
    const key = rideImageKeyParamSchema.parse(req.params.key);
    await archiveRideImage(req, key);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
