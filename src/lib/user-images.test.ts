import { describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { AVATAR_PRESETS, COVER_PRESETS } from "../config/user-image-presets.js";
import { avatarFieldsOf, resolveImageUrl, toImageAsset, userImageFieldsOf } from "./user-images.js";

const GOOGLE = "https://lh3.googleusercontent.com/a/photo";

/** A user as they exist today: signed up with Google, has never touched the new columns. */
const legacyUser = {
  avatarUrl: GOOGLE,
  avatarType: null,
  avatarValue: null,
  coverType: null,
  coverValue: null,
};

describe("resolveImageUrl — the backward-compatibility rule", () => {
  it("an upload wins over everything", () => {
    expect(resolveImageUrl("avatar", "upload", "users/12/avatar-9f3a.webp", GOOGLE)).toBe(
      `${env.PUBLIC_BASE_URL}/uploads/users/12/avatar-9f3a.webp`,
    );
  });

  it("a preset resolves to its shipped asset", () => {
    expect(resolveImageUrl("avatar", "preset", "avatar-mtb-01", GOOGLE)).toBe(
      `${env.PUBLIC_BASE_URL}/assets/presets/avatars/avatar-mtb-01.svg`,
    );
  });

  it("falls back to the Google picture when nothing is chosen", () => {
    expect(resolveImageUrl("avatar", null, null, GOOGLE)).toBe(GOOGLE);
  });

  it("is null when there is nothing at all", () => {
    expect(resolveImageUrl("avatar", null, null, null)).toBeNull();
  });

  it("falls back rather than rendering a preset id this server no longer publishes", () => {
    expect(resolveImageUrl("avatar", "preset", "avatar-retired-99", GOOGLE)).toBe(GOOGLE);
  });

  it("ignores a stored type it does not recognise", () => {
    expect(resolveImageUrl("avatar", "s3", "bucket/key.png", GOOGLE)).toBe(GOOGLE);
  });

  it("gives a cover no Google fallback — there is no legacy cover", () => {
    expect(resolveImageUrl("cover", null, null, GOOGLE)).toBeNull();
  });

  it("resolves a cover preset and a cover upload", () => {
    expect(resolveImageUrl("cover", "preset", "cover-ocean-01")).toBe(
      `${env.PUBLIC_BASE_URL}/assets/presets/covers/cover-ocean-01.svg`,
    );
    expect(resolveImageUrl("cover", "upload", "users/12/cover-abc.jpg")).toBe(
      `${env.PUBLIC_BASE_URL}/uploads/users/12/cover-abc.jpg`,
    );
  });

  it("does not accept an avatar preset id for a cover, or the reverse", () => {
    expect(resolveImageUrl("cover", "preset", "avatar-mtb-01")).toBeNull();
    expect(resolveImageUrl("avatar", "preset", "cover-ocean-01", GOOGLE)).toBe(GOOGLE);
  });
});

describe("toImageAsset — the shape the web client already reads", () => {
  it("gives a preset both its resolved url and its id", () => {
    // UserVisualAsset in podium-client/src/lib/user-identity.ts: url / presetId / source.
    expect(toImageAsset("avatar", "preset", "avatar-mtb-01")).toEqual({
      url: `${env.PUBLIC_BASE_URL}/assets/presets/avatars/avatar-mtb-01.svg`,
      presetId: "avatar-mtb-01",
      source: "preset",
    });
  });

  it("gives an upload a resolved url and no preset id", () => {
    expect(toImageAsset("avatar", "upload", "users/12/avatar-9f3a.webp")).toEqual({
      url: `${env.PUBLIC_BASE_URL}/uploads/users/12/avatar-9f3a.webp`,
      presetId: null,
      source: "upload",
    });
  });

  it("never leaks the stored relative reference in place of a URL", () => {
    const asset = toImageAsset("avatar", "upload", "users/12/avatar-9f3a.webp");
    expect(asset?.url?.startsWith("http")).toBe(true);
  });

  it("is null when nothing is chosen, or the stored type is unknown", () => {
    expect(toImageAsset("avatar", null, null)).toBeNull();
    expect(toImageAsset("avatar", "preset", null)).toBeNull();
    expect(toImageAsset("avatar", "s3", "bucket/key.png")).toBeNull();
  });

  it("is null for a preset id this server does not publish", () => {
    expect(toImageAsset("avatar", "preset", "avatar-retired-99")).toBeNull();
  });
});

describe("serializer fields", () => {
  it("an untouched legacy user gets exactly today's answer, plus nulls", () => {
    expect(userImageFieldsOf(legacyUser)).toEqual({
      avatarUrl: GOOGLE,
      avatar: null,
      coverUrl: null,
      cover: null,
    });
  });

  it("a user with no Google photo and no choice is entirely null — and still valid", () => {
    expect(userImageFieldsOf({ ...legacyUser, avatarUrl: null })).toEqual({
      avatarUrl: null,
      avatar: null,
      coverUrl: null,
      cover: null,
    });
  });

  it("avatarFieldsOf carries the effective URL and the richer object side by side", () => {
    expect(
      avatarFieldsOf({ ...legacyUser, avatarType: "upload", avatarValue: "users/7/avatar-aa.png" }),
    ).toEqual({
      avatarUrl: `${env.PUBLIC_BASE_URL}/uploads/users/7/avatar-aa.png`,
      avatar: {
        url: `${env.PUBLIC_BASE_URL}/uploads/users/7/avatar-aa.png`,
        presetId: null,
        source: "upload",
      },
    });
  });
});

describe("the preset registry", () => {
  it("publishes stable, unique ids", () => {
    const ids = [...AVATAR_PRESETS, ...COVER_PRESETS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // These are the ids the web client stores (podium-client/src/lib/identity-presets.ts).
  // If this list and that one drift, a rider's saved choice stops resolving on one side.
  it("matches the ids the client's library already uses", () => {
    const coverIds = COVER_PRESETS.map((p) => p.id);
    const avatarIds = AVATAR_PRESETS.map((p) => p.id);
    expect(coverIds).toContain("cover-mountain-02");
    expect(coverIds).toContain("cover-ocean-01");
    expect(avatarIds).toContain("avatar-mtb-01");
    expect(coverIds).toHaveLength(20);
    expect(avatarIds).toHaveLength(14);
  });

  it("names every file it publishes after its own id", () => {
    for (const preset of [...AVATAR_PRESETS, ...COVER_PRESETS]) {
      expect(preset.file.endsWith(`/${preset.id}.svg`)).toBe(true);
    }
  });
});
