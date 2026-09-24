// The built-in ride-image registry — the contract for what events.ride_image_key may name.
//
// A ride image is a stable key plus one shared static file that ships with the CLIENT (there is
// no image endpoint and no binary storage here — see sql/051-events-ride-image.sql). Choosing one
// stores the key and nothing else.
//
// ── This list mirrors the web client's library ──────────────────────────────────────────────
//
// The same keys, and the same artwork, exist in elnino-client/src/lib/ride-images.ts and
// elnino-client/public/ride-images/. This server-side copy exists only to validate a client-
// supplied key on create/update (z.enum(RIDE_IMAGE_KEYS) in src/schemas/event.schemas.ts) — the
// server never resolves a key to a URL or serves the image itself.
//
// A KEY IS PERMANENT. Never rename one, never reuse a retired one, and never repoint an existing
// key at different artwork — an existing ride's stored value is that string. To retire an image,
// set `selectable: false` on the client registry entry (this file only needs the keys); to add
// one, append a new key here AND a matching entry on the client. Both lists are append-only.

/** V1: three curated Sukkot images. Append here (and on the client) to add more — never remove
 *  or reorder an existing entry, see header. */
export const RIDE_IMAGE_KEYS = ["sukkot-01", "sukkot-02", "sukkot-03"] as const;

export type RideImageKey = (typeof RIDE_IMAGE_KEYS)[number];

const RIDE_IMAGE_KEY_SET = new Set<string>(RIDE_IMAGE_KEYS);

export function isRideImageKey(value: unknown): value is RideImageKey {
  return typeof value === "string" && RIDE_IMAGE_KEY_SET.has(value);
}
