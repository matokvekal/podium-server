// Account-wide switches an operator flips by hand in psql — see sql/029-app-flags.sql.
//
// One tiny table, one read here, wrapped in a short in-memory cache so a flag that is checked
// on every authenticated request (event_creation_open_to_all, from resolveEntitlements) costs
// one query every FLAG_CACHE_MS at most, not one per request. The trade-off is that flipping a
// flag in the database takes up to that long to take effect on every node — acceptable for the
// kind of decision this table holds ("open ride creation for a few weeks").

import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";

/** How long a read is trusted before the table is consulted again. */
export const FLAG_CACHE_MS = 30_000;

interface CacheEntry {
  value: string | null;
  readAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — drop the cache so a test's mocked value is read immediately. */
export function clearAppFlagCache(): void {
  cache.clear();
}

/**
 * The raw string value of a flag, or null when the key is not set (or the table does not exist
 * yet — a database from before sql/029). Cached for FLAG_CACHE_MS.
 */
export async function getAppFlag(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.readAt < FLAG_CACHE_MS) return hit.value;

  let value: string | null = null;
  try {
    const rows = await query<{ value: string }>("SELECT value FROM app_flags WHERE key = $1", [key]);
    value = rows[0]?.value ?? null;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    // 42P01 = table missing (pre-sql/029). Every flag reads as its default until the migration
    // runs — the server must not fail a request over an unapplied migration.
    if (code === "42P01") {
      logger.warn({ key }, "app_flags table missing; treating flag as unset");
    } else {
      throw err;
    }
  }

  cache.set(key, { value, readAt: Date.now() });
  return value;
}

/** A flag interpreted as a boolean — true only for the exact string "true". Unset → false. */
export async function isAppFlagOn(key: string): Promise<boolean> {
  return (await getAppFlag(key)) === "true";
}
