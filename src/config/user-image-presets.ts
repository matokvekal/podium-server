// The preset registry — the contract for what {avatar,cover}_type = 'preset' may name.
//
// A preset is a stable id plus one shared file that ships with the application in
// assets/presets/. Choosing a preset stores the id and nothing else: no file is copied, no
// bytes are written, and ten thousand riders on cover-ocean-01 cost one file on disk.
//
// ── This list mirrors the web client's library ──────────────────────────────────────────────
//
// The same ids, and the same artwork, exist in podium-client/src/lib/identity-presets.ts and
// podium-client/public/identity-presets/. That client shipped FIRST, deliberately, and stores
// these strings already — so this file follows it rather than inventing a parallel vocabulary.
// The server keeps its own copy of the art for one reason: it has to be able to resolve a
// preset id into a real URL for a client that cannot (an older build, or the Android app),
// which is what keeps the flat `avatarUrl` field correct for everyone. See lib/user-images.ts.
//
// AN ID IS PERMANENT. Never rename one, never reuse a retired one, and never repoint an
// existing id at different artwork — somebody's stored identity is that string. To change a
// picture, add a new id. Adding presets is safe and additive; both lists here are append-only,
// and they must stay in step with the client's registry.

import type { UserImageKind } from "./user-images.js";

export interface ImagePreset {
  /** Stable public id, stored verbatim in users.{avatar,cover}_value. */
  id: string;
  /** Path under assets/presets/ — always `<dir>/<id>.svg`, so an entry and its file
   *  cannot drift apart. */
  file: string;
}

/** 256x256, 1:1. Mirrors AVATAR_PRESETS in the client registry. */
const AVATAR_PRESET_IDS = [
  "avatar-mtb-01",
  "avatar-road-01",
  "avatar-gravel-01",
  "avatar-running-01",
  "avatar-mountain-01",
  "avatar-forest-01",
  "avatar-ocean-01",
  "avatar-sky-01",
  "avatar-sunset-01",
  "avatar-night-01",
  "avatar-stars-01",
  "avatar-abstract-01",
  "avatar-abstract-02",
  "avatar-abstract-03",
] as const;

/** 1200x450, 8:3. Mirrors COVER_PRESETS in the client registry. */
const COVER_PRESET_IDS = [
  "cover-road-01",
  "cover-road-02",
  "cover-mtb-01",
  "cover-mtb-02",
  "cover-gravel-01",
  "cover-running-01",
  "cover-mountain-01",
  "cover-mountain-02",
  "cover-forest-01",
  "cover-forest-02",
  "cover-ocean-01",
  "cover-ocean-02",
  "cover-sky-01",
  "cover-sunset-01",
  "cover-sunset-02",
  "cover-sunset-03",
  "cover-night-01",
  "cover-stars-01",
  "cover-abstract-01",
  "cover-abstract-02",
] as const;

export const AVATAR_PRESETS: readonly ImagePreset[] = AVATAR_PRESET_IDS.map((id) => ({
  id,
  file: `avatars/${id}.svg`,
}));

export const COVER_PRESETS: readonly ImagePreset[] = COVER_PRESET_IDS.map((id) => ({
  id,
  file: `covers/${id}.svg`,
}));

export function presetsFor(kind: UserImageKind): readonly ImagePreset[] {
  return kind === "avatar" ? AVATAR_PRESETS : COVER_PRESETS;
}

/** null for an id this server does not publish — the caller turns that into a 400. */
export function findPreset(kind: UserImageKind, id: string): ImagePreset | null {
  return presetsFor(kind).find((preset) => preset.id === id) ?? null;
}
