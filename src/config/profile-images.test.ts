// config/profile-images.ts against the checked-in fixture directory (vitest.config.ts points
// PROFILE_IMAGES_DIR at src/config/__fixtures__/profile-images, NOT the real operator-managed
// images/PUBLIC-APP-IMAGES folder, which lives outside this repo and outside CI's checkout).
//
// The fixture folder holds: trail-01.webp, trail-02.png (both selectable), ignored-notes.txt
// (wrong extension) and .hidden.webp (dotfile, allowed extension but still excluded).

import { describe, expect, it } from "vitest";
import { env } from "./env.js";
import { isProfileImageKey, listProfileImages, profileImagePublicUrl } from "./profile-images.js";

describe("listProfileImages — the live catalog", () => {
  it("lists only the allowed-extension, non-dotfile fixtures", async () => {
    const images = await listProfileImages();
    expect(images.map((i) => i.key)).toEqual(["trail-01.webp", "trail-02.png"]);
  });

  it("resolves each key to an absolute, immediately-fetchable URL", async () => {
    const images = await listProfileImages();
    for (const image of images) {
      expect(image.url).toBe(`${env.PUBLIC_BASE_URL}/public-app-images/${image.key}`);
    }
  });
});

describe("isProfileImageKey — the write-time gate", () => {
  it("accepts a key that is actually on disk", async () => {
    expect(await isProfileImageKey("trail-01.webp")).toBe(true);
    expect(await isProfileImageKey("trail-02.png")).toBe(true);
  });

  it("rejects a filename this folder does not contain", async () => {
    expect(await isProfileImageKey("does-not-exist.webp")).toBe(false);
  });

  it("rejects a file present on disk but with a disallowed extension", async () => {
    expect(await isProfileImageKey("ignored-notes.txt")).toBe(false);
  });

  it("rejects a dotfile even though its extension is allowed", async () => {
    expect(await isProfileImageKey(".hidden.webp")).toBe(false);
  });

  it("rejects a traversal attempt without ever reaching the filesystem", async () => {
    expect(await isProfileImageKey("../../etc/passwd")).toBe(false);
    expect(await isProfileImageKey("..%2f..%2fetc%2fpasswd.webp")).toBe(false);
  });

  it("rejects a path, not just an unknown key", async () => {
    expect(await isProfileImageKey("subdir/trail-01.webp")).toBe(false);
    expect(await isProfileImageKey("subdir\\trail-01.webp")).toBe(false);
  });

  it("rejects an external URL", async () => {
    expect(await isProfileImageKey("https://evil.example/x.webp")).toBe(false);
  });

  it("rejects the empty string", async () => {
    expect(await isProfileImageKey("")).toBe(false);
  });
});

describe("profileImagePublicUrl", () => {
  it("builds an absolute URL under the public-app-images prefix", () => {
    expect(profileImagePublicUrl("trail-01.webp")).toBe(
      `${env.PUBLIC_BASE_URL}/public-app-images/trail-01.webp`,
    );
  });
});
