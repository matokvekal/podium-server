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
