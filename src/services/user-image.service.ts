// Setting, replacing and clearing a rider's avatar and cover.
//
// The order below is the whole design and is the same for a preset and for an upload:
//
//     validate  ->  store the new file  ->  UPDATE users  ->  remove the old file
//
// The old file goes last and never fails the request. Deleting first would mean a failed
// write leaves the rider with nothing; failing the request on a stubborn unlink would mean
// reporting an error for a change that already succeeded. An unlink that does not happen
// leaves exactly one orphan, which scripts/cleanup-user-uploads.mjs exists to collect.

import type { Request } from "express";
import { findPreset } from "../config/user-image-presets.js";
import type { UserImageKind } from "../config/user-images.js";
import type { User } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { AUDIT_ACTIONS, audit } from "../lib/audit.js";
import { inspectImage } from "../lib/image-inspect.js";
import { deleteUpload, storeUpload } from "../lib/user-image-storage.js";
import { selectUserById, updateUserImage } from "../queries/user.queries.js";

const CHANGED_ACTION = {
  avatar: AUDIT_ACTIONS.USER_AVATAR_CHANGED,
  cover: AUDIT_ACTIONS.USER_COVER_CHANGED,
} as const;

const RESET_ACTION = {
  avatar: AUDIT_ACTIONS.USER_AVATAR_RESET,
  cover: AUDIT_ACTIONS.USER_COVER_RESET,
} as const;

function storedUpload(user: User, kind: UserImageKind): string | null {
  const type = kind === "avatar" ? user.avatarType : user.coverType;
  const value = kind === "avatar" ? user.avatarValue : user.coverValue;
  return type === "upload" && value ? value : null;
}

async function loadUser(userId: number): Promise<User> {
  const user = await selectUserById(userId);
  // A valid token for a row that no longer exists — the caller's identity is what is gone.
  if (!user) throw new ApiError(401, "This account no longer exists");
  return user;
}

/** Drops the file the user is no longer pointing at. Presets are shared, shipped art and are
 *  never touched — only a value that was an 'upload' names a file this user owns. */
async function discardPreviousUpload(previous: User, kind: UserImageKind): Promise<void> {
  const ref = storedUpload(previous, kind);
  if (ref) await deleteUpload(ref);
}

/**
 * Choose one of the built-in images. Nothing is copied: the registry id is stored, and the
 * single shared file in assets/presets/ serves every rider who picked it.
 */
export async function setPreset(
  req: Request,
  userId: number,
  kind: UserImageKind,
  presetId: string,
): Promise<User> {
  if (!findPreset(kind, presetId)) {
    throw new ApiError(400, `There is no ${kind} preset called "${presetId}"`);
  }

  const previous = await loadUser(userId);
  const updated = await updateUserImage(userId, kind, "preset", presetId);
  if (!updated) throw new ApiError(401, "This account no longer exists");

  await discardPreviousUpload(previous, kind);

  audit(req, CHANGED_ACTION[kind], {
    entity: "user",
    entityId: userId,
    meta: { source: "preset", presetId },
  });
  return updated;
}

/**
 * Store an uploaded image. `bytes` is the raw request body; nothing else about the request
 * is trusted — not the declared content type, and certainly not a filename, which this path
 * never receives in the first place.
 *
 * The buffer is written exactly as received. An animated GIF stays animated because nothing
 * here re-encodes it.
 */
export async function setUpload(
  req: Request,
  userId: number,
  kind: UserImageKind,
  bytes: Buffer,
): Promise<User> {
  const image = inspectImage(bytes, kind);

  const previous = await loadUser(userId);
  const ref = await storeUpload(userId, kind, bytes, image.ext);

  const updated = await updateUserImage(userId, kind, "upload", ref);
  if (!updated) {
    // The account vanished between the two reads. Do not leave the file we just wrote behind.
    await deleteUpload(ref);
    throw new ApiError(401, "This account no longer exists");
  }

  await discardPreviousUpload(previous, kind);

  audit(req, CHANGED_ACTION[kind], {
    entity: "user",
    entityId: userId,
    meta: {
      source: "upload",
      format: image.format,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
    },
  });
  return updated;
}

/**
 * Clear the choice. For an avatar this falls back to the Google picture, which was never
 * overwritten; for a cover it means no cover.
 */
export async function resetImage(req: Request, userId: number, kind: UserImageKind): Promise<User> {
  const previous = await loadUser(userId);
  const updated = await updateUserImage(userId, kind, null, null);
  if (!updated) throw new ApiError(401, "This account no longer exists");

  await discardPreviousUpload(previous, kind);

  audit(req, RESET_ACTION[kind], { entity: "user", entityId: userId });
  return updated;
}
