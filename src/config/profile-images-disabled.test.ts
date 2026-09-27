// The gallery DISABLED (env.PROFILE_IMAGES_DIR === null — see config/env.ts's
// resolveProfileImagesDir, which used to process.exit(1) in this exact situation). A separate
// file from profile-images.test.ts so each gets its own fresh module instance (Vitest isolates
// per test file by default) — this one mutates the shared `env` object at module scope, which
// must never leak into the fixture-backed tests in the other file.

import { beforeAll, describe, expect, it } from "vitest";
import { env } from "./env.js";
import { isProfileImageKey, listProfileImages } from "./profile-images.js";

beforeAll(() => {
  env.PROFILE_IMAGES_DIR = null;
});

describe("the gallery is disabled (no PROFILE_IMAGES_DIR configured)", () => {
  it("listProfileImages resolves to an empty catalog rather than throwing", async () => {
    await expect(listProfileImages()).resolves.toEqual([]);
  });

  it("isProfileImageKey rejects every key, cleanly, rather than throwing", async () => {
    expect(await isProfileImageKey("trail-01.webp")).toBe(false);
    expect(await isProfileImageKey("anything.webp")).toBe(false);
  });
});
