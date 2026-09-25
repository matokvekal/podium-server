// selectGalleryImageSchema — the first of two locks on a gallery pick (config/profile-images.ts
// does the second: does this name exist in PROFILE_IMAGES_DIR right now). This one only checks
// SHAPE — a syntactically fine but nonexistent filename is a service-layer 400, not a schema one.

import { describe, expect, it } from "vitest";
import { selectGalleryImageSchema } from "./user-image.schemas.js";

describe("selectGalleryImageSchema", () => {
  it("accepts a plain filename with an allowed extension", () => {
    for (const key of ["trail-01.webp", "trail_02.png", "Trail03.JPG", "a.jpeg"]) {
      expect(selectGalleryImageSchema.safeParse({ galleryKey: key }).success).toBe(true);
    }
  });

  it("rejects a disallowed extension", () => {
    for (const key of ["trail-01.gif", "trail-01.svg", "trail-01.exe", "trail-01"]) {
      expect(selectGalleryImageSchema.safeParse({ galleryKey: key }).success).toBe(false);
    }
  });

  it("rejects a path — only a bare filename may reach the service layer", () => {
    for (const key of ["../../etc/passwd", "../secret.webp", "sub/dir.webp", "sub\\dir.webp"]) {
      expect(selectGalleryImageSchema.safeParse({ galleryKey: key }).success).toBe(false);
    }
  });

  it("rejects an external URL", () => {
    expect(
      selectGalleryImageSchema.safeParse({ galleryKey: "https://evil.example/x.webp" }).success,
    ).toBe(false);
  });

  it("rejects an empty or missing value", () => {
    expect(selectGalleryImageSchema.safeParse({ galleryKey: "" }).success).toBe(false);
    expect(selectGalleryImageSchema.safeParse({}).success).toBe(false);
  });
});
