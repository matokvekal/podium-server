import { z } from "zod";

/**
 * Choosing a preset. The id is checked for shape here and for existence against the registry
 * in the service — a syntactically fine id that this server does not publish is still a 400,
 * never a stored value.
 */
export const selectPresetSchema = z.object({
  presetId: z
    .string()
    .min(3)
    .max(64)
    // The registry's own vocabulary. Nothing that could be a path, a URL or a filename.
    .regex(/^[a-z0-9-]+$/, "A preset id contains only lowercase letters, digits and hyphens"),
});

/**
 * Choosing a picture from the operator-managed profile-image gallery (config/profile-images.ts).
 * Unlike a preset id this IS a filename — but only ever a bare one: the regex is the first lock
 * against a path or a URL reaching the service layer, which then does the real check (does this
 * name exist in PROFILE_IMAGES_DIR right now) against the live directory listing, not a
 * compiled registry.
 */
export const selectGalleryImageSchema = z.object({
  galleryKey: z
    .string()
    .min(3)
    .max(128)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.(webp|png|jpe?g)$/i,
      "A gallery key is a bare filename ending in .webp, .png, .jpg or .jpeg",
    )
    .refine((value) => !value.includes(".."), "A gallery key may not contain '..'"),
});
