import type { NextFunction, Request, Response } from "express";
import { presetsFor } from "../config/user-image-presets.js";
import { USER_IMAGE_KINDS, type UserImageKind } from "../config/user-images.js";
import { ApiError } from "../lib/api-error.js";
import { traceLog } from "../lib/trace-log.js";
import { presetPublicUrl } from "../lib/user-images.js";
import { selectPresetSchema } from "../schemas/user-image.schemas.js";
import { resetImage, setPreset, setUpload } from "../services/user-image.service.js";
import { toProfile } from "./user.controller.js";

/**
 * A user's avatar and cover.
 *
 * Every route here is "/me". There is deliberately no ":userId" form: the id comes from the
 * verified access token and nowhere else, so "user A edits user B" is not a case that has to
 * be checked — it is a request that cannot be expressed.
 */

/**
 * PUT accepts either shape on the same path, told apart by Content-Type:
 *
 *   application/json  { "presetId": "avatar-mtb-01" }   -> choose a built-in image
 *   image/png|jpeg|webp|gif  <raw bytes>                  -> upload
 *
 * express.raw() in app.ts buffers only the image content types (and only up to that kind's
 * byte limit); a JSON body falls through to the ordinary parser. `req.body` is therefore a
 * Buffer for one and a plain object for the other.
 */
function isUploadBody(req: Request): boolean {
  return Buffer.isBuffer(req.body);
}

function putImage(kind: UserImageKind) {
  return async (req: Request, res: Response, next: NextFunction) => {
    traceLog("user-image.controller.putImage", { userId: req.auth!.userId, kind });
    try {
      const userId = req.auth!.userId;

      if (isUploadBody(req)) {
        const user = await setUpload(req, userId, kind, req.body as Buffer);
        return res.status(200).json({ data: toProfile(user) });
      }

      // Not a Buffer and not JSON we can read: usually a Content-Type we do not accept, which
      // is worth saying plainly rather than failing validation on an empty body.
      if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
        throw new ApiError(
          415,
          `Send a ${kind} as JPEG, PNG, WebP or GIF bytes with a matching Content-Type, ` +
            `or as JSON { "presetId": "..." }`,
        );
      }

      const { presetId } = selectPresetSchema.parse(req.body);
      const user = await setPreset(req, userId, kind, presetId);
      res.status(200).json({ data: toProfile(user) });
    } catch (err) {
      next(err);
    }
  };
}

function deleteImage(kind: UserImageKind) {
  return async (req: Request, res: Response, next: NextFunction) => {
    traceLog("user-image.controller.deleteImage", { userId: req.auth!.userId, kind });
    try {
      const user = await resetImage(req, req.auth!.userId, kind);
      res.status(200).json({ data: toProfile(user) });
    } catch (err) {
      next(err);
    }
  };
}

// PUT/DELETE /api/v1/users/me/avatar
export const putAvatarController = putImage("avatar");
export const deleteAvatarController = deleteImage("avatar");

// PUT/DELETE /api/v1/users/me/cover
export const putCoverController = putImage("cover");
export const deleteCoverController = deleteImage("cover");

/**
 * The preset catalogue, so a client renders exactly the ids this server will accept instead
 * of the two drifting apart. Public: it is a static list of shipped art with no user data in
 * it, and a sign-in screen may want to show it.
 */
// GET /api/v1/users/image-presets
export function listImagePresetsController(_req: Request, res: Response) {
  traceLog("user-image.controller.listImagePresetsController");
  const catalogue = Object.fromEntries(
    USER_IMAGE_KINDS.map((kind) => [
      kind === "avatar" ? "avatars" : "covers",
      presetsFor(kind).map((preset) => ({ id: preset.id, url: presetPublicUrl(preset.file) })),
    ]),
  );
  res.status(200).json({ data: catalogue });
}
