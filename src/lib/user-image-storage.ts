// The only module in the server that touches the upload filesystem. Everything else deals in
// the relative reference stored in the database ("users/12/avatar-9f3a….webp") and never
// learns where that actually lives — which is what keeps the absolute path out of responses,
// out of logs, and out of anything a client can influence.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import type { UserImageKind } from "../config/user-images.js";
import { logger } from "./logger.js";

/** URL prefix the uploads are served under, by express.static in dev and nginx in production. */
export const UPLOADS_URL_PREFIX = "/uploads";

/** Where every user's images live, relative to UPLOADS_DIR. */
const USERS_SUBDIR = "users";

/**
 * The stored reference for one uploaded file, e.g. "users/12/avatar-9f3a2b71c4d5e6f7.webp".
 *
 * Always POSIX separators, even on Windows: it is a database value and a URL tail, not a
 * filesystem path, and it has to mean the same thing on a developer laptop and on the Linux
 * box that serves it.
 */
export type UploadRef = string;

function usersRoot(): string {
  return path.join(env.UPLOADS_DIR, USERS_SUBDIR);
}

/**
 * Resolve a stored reference to a real path, refusing anything that escapes the upload root.
 *
 * No client-supplied string reaches this function today — references are generated here and
 * read back from our own column. This is the second lock on that door: a traversal attempt
 * that ever did get into the column ("../../etc/passwd") fails here instead of deleting or
 * serving a file outside the tree.
 */
export function resolveUploadPath(ref: UploadRef): string {
  const root = env.UPLOADS_DIR;
  const resolved = path.resolve(root, ref);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("upload reference escapes the upload root");
  }
  return resolved;
}

/** The absolute URL a client fetches this image from. */
export function uploadPublicUrl(ref: UploadRef): string {
  return `${env.PUBLIC_BASE_URL}${UPLOADS_URL_PREFIX}/${ref}`;
}

/**
 * Write validated bytes and return the reference to store.
 *
 * The name is ours end to end: `{kind}-{16 hex}.{ext}`, where the extension comes from the
 * format we sniffed out of the bytes, not from the request. Nothing the caller sent
 * participates in the path, so an unsafe original filename is not sanitised — it never
 * exists in the first place.
 *
 * The random token also means a replacement never reuses a URL, so the long immutable cache
 * on /uploads is safe and a stale copy in a browser or CDN can never mask a change.
 */
export async function storeUpload(
  userId: number,
  kind: UserImageKind,
  bytes: Buffer,
  ext: string,
): Promise<UploadRef> {
  const dir = path.join(usersRoot(), String(userId));
  await mkdir(dir, { recursive: true });

  const ref = `${USERS_SUBDIR}/${userId}/${kind}-${randomBytes(8).toString("hex")}.${ext}`;
  // Bytes go to disk exactly as they arrived — no re-encode, no resize, no metadata strip.
  // An animated GIF that comes in animated goes out animated.
  await writeFile(resolveUploadPath(ref), bytes);
  return ref;
}

/**
 * Delete a previous upload. Best effort on purpose: this runs AFTER the database already
 * points at the new file, so a failure here leaves one orphan for the sweeper
 * (scripts/cleanup-user-uploads.mjs) rather than failing a request the user already
 * completed successfully.
 */
export async function deleteUpload(ref: UploadRef): Promise<void> {
  let target: string;
  try {
    target = resolveUploadPath(ref);
  } catch {
    // A stored value that does not resolve inside the root is not ours to delete.
    logger.warn({ kind: "user-upload" }, "refusing to delete an out-of-root upload reference");
    return;
  }

  try {
    await rm(target, { force: true });
  } catch (err) {
    // Deliberately not the path — see logging rules in TODO-install-server.md §11.
    logger.warn({ err: (err as Error).message }, "could not remove a replaced user upload");
  }
}

/** Every file currently on disk for one user, as stored references. Used by the sweeper. */
export async function listUserUploads(userId: number): Promise<UploadRef[]> {
  const dir = path.join(usersRoot(), String(userId));
  try {
    const names = await readdir(dir);
    return names.map((name) => `${USERS_SUBDIR}/${userId}/${name}`);
  } catch {
    return [];
  }
}

/** Ensures the upload root exists at boot, so the first upload is not the thing that finds
 *  out the directory is missing or unwritable. */
export async function ensureUploadRoot(): Promise<void> {
  await mkdir(usersRoot(), { recursive: true });
}
