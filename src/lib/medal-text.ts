// The completion-medal dedication (sql/061): what an organizer writes on the medal every rider of
// their ride receives. The limit is in WORDS, not characters, because that is what the organizer
// sees in the form; the client counts the same way (elnino-client src/lib/medal.ts).

export const MEDAL_TEXT_MAX_WORDS = 30;
/** A hard byte-ish backstop on top of the word limit, so 30 enormous "words" can't be stored. */
export const MEDAL_TEXT_MAX_CHARS = 600;

/** Words = runs of non-whitespace. Works the same for Hebrew, Arabic and English. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

// The medal's background: the organizer picks one colour and one style (client
// src/lib/medal-backgrounds.ts draws them). Stored as these short ids, never as an image. The
// lists must match the client's; a client that meets an id it does not know draws the original
// look, so adding ids later is safe in either order.
export const MEDAL_COLOR_IDS = [
  "classic", "champagne", "pearl", "blush", "peach", "sand", "sage", "mint", "sky", "lavender",
  "navy", "midnight", "royal", "teal", "emerald", "forest", "burgundy", "plum", "bronze", "charcoal",
] as const;
export const MEDAL_STYLE_IDS = [
  "glow", "solid", "sunburst", "spotlight", "silk", "linen", "pinstripe", "dots", "argyle", "ripple",
] as const;
