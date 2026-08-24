// Turning what is stored about a user's images into what the API returns. Pure: no SQL, no
// filesystem, no request — so every serializer that shows a person (profile, event owner,
// participant row, results organizer, LIVE payload) can call it and they cannot drift apart.
//
// THE COMPATIBILITY RULE
//
// `avatarUrl` is the field every existing client already reads, and it keeps its name, its
// type and its nullability. What changes is that it now answers "the avatar to show" instead
// of "the Google photo", resolved in this order:
//
//     1. an uploaded image        -> its /uploads URL
//     2. a chosen preset          -> that preset's /assets URL
//     3. the Google picture       -> users.avatar_url, exactly as before
//     4. nothing                  -> null, exactly as before
//
// So a client that has never heard of this feature shows the rider's real, current avatar
// with no change at all, and a client that has reads the richer `avatar` object next to it.
// users.avatar_url is never overwritten, which is what makes step 3 still true after a reset.
//
// A cover has no step 3: there is no legacy cover anywhere, so an unset cover is simply null.

import { env } from "../config/env.js";
import { findPreset } from "../config/user-image-presets.js";
import {
  isUserImageSource,
  type UserImageKind,
  type UserImageSource,
} from "../config/user-images.js";
import { uploadPublicUrl } from "./user-image-storage.js";

/** URL prefix the shipped preset art is served under. */
export const PRESET_URL_PREFIX = "/assets/presets";

/**
 * One image as a client that knows about the feature reads it. Null when nothing is chosen.
 *
 * The field names are not ours to pick: this is UserVisualAsset in the web client
 * (podium-client/src/lib/user-identity.ts), which shipped before this server did and already
 * resolves `url` / `presetId` in that order. `source` is advisory — the client reads the two
 * value fields directly, so it degrades safely either way.
 *
 * Exactly one of `url` / `presetId` is ever set. `url` is the fully resolved, absolute image
 * URL rather than the stored relative reference, because where an upload lives on disk is
 * deployment configuration and no client should be given it.
 */
export interface UserImageAsset {
  url: string | null;
  presetId: string | null;
  source: UserImageSource;
}

/** What a user's stored image columns look like on any row that joined `users`. */
export interface StoredUserImages {
  avatarUrl: string | null;
  avatarType?: string | null;
  avatarValue?: string | null;
  coverType?: string | null;
  coverValue?: string | null;
}

export function presetPublicUrl(file: string): string {
  return `${env.PUBLIC_BASE_URL}${PRESET_URL_PREFIX}/${file}`;
}

/**
 * The asset object, or null when this user has not chosen anything. A stored type we do not
 * recognise is reported as null rather than echoed back — a client should fall back, not try
 * to render a source it has no rule for.
 */
export function toImageAsset(
  kind: UserImageKind,
  type: string | null | undefined,
  value: string | null | undefined,
): UserImageAsset | null {
  if (!type || !value || !isUserImageSource(type)) return null;

  if (type === "upload") {
    return { url: uploadPublicUrl(value), presetId: null, source: "upload" };
  }

  // A preset id this server does not publish is not echoed back as if it were valid.
  const preset = findPreset(kind, value);
  if (!preset) return null;
  return { url: presetPublicUrl(preset.file), presetId: preset.id, source: "preset" };
}

/**
 * The URL to actually show. `googleAvatarUrl` is only consulted for the avatar, and only as
 * the last resort — see the compatibility rule at the top of this file.
 *
 * An unknown preset id resolves to null and falls through, so a preset that is retired from
 * the registry degrades to the previous avatar instead of rendering a broken image.
 */
export function resolveImageUrl(
  kind: UserImageKind,
  type: string | null | undefined,
  value: string | null | undefined,
  googleAvatarUrl: string | null = null,
): string | null {
  if (type === "upload" && value) return uploadPublicUrl(value);

  if (type === "preset" && value) {
    const preset = findPreset(kind, value);
    if (preset) return presetPublicUrl(preset.file);
  }

  return kind === "avatar" ? (googleAvatarUrl ?? null) : null;
}

/** The avatar half, for the many serializers that show a person but never a cover. */
export function avatarFieldsOf(row: StoredUserImages): {
  avatarUrl: string | null;
  avatar: UserImageAsset | null;
} {
  return {
    avatarUrl: resolveImageUrl("avatar", row.avatarType, row.avatarValue, row.avatarUrl),
    avatar: toImageAsset("avatar", row.avatarType, row.avatarValue),
  };
}

/** Both images — for the profile and for an event's owner. */
export function userImageFieldsOf(row: StoredUserImages): {
  avatarUrl: string | null;
  avatar: UserImageAsset | null;
  coverUrl: string | null;
  cover: UserImageAsset | null;
} {
  return {
    ...avatarFieldsOf(row),
    coverUrl: resolveImageUrl("cover", row.coverType, row.coverValue),
    cover: toImageAsset("cover", row.coverType, row.coverValue),
  };
}
