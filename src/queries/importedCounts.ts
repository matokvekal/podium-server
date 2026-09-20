// routes.imported_like_count / routes.imported_download_count (sql/043) are an imported starting
// popularity, ADDED to the real counts derived from route_likes / route_copies rows at read time.
// Every reader of those counts goes through the same "retry without the seed" rule, so a database
// that has not reached sql/043 keeps showing real counts instead of failing.

import { logger } from "../lib/logger.js";

/** Postgres 42703 (undefined_column) naming one of the two imported-count columns. */
export function isMissingImportedCountColumn(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === "42703" && /imported_(download|like)_count/.test(String(message ?? ""));
}

/** Runs the seeded statement; on a missing column logs once-per-call and runs the plain one. */
export async function withImportedCounts<T>(
  seeded: () => Promise<T>,
  plain: () => Promise<T>,
): Promise<T> {
  try {
    return await seeded();
  } catch (err) {
    if (!isMissingImportedCountColumn(err)) throw err;
    logger.warn({ err }, "routes.imported_*_count missing — run sql/043-route-imported-counts.sql");
    return plain();
  }
}
