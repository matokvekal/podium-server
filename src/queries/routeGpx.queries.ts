// SQL for THE ORIGINAL GPX FILE of a route — route_gpx_files (sql/042).
//
// Read ONLY by GET /routes/:routeId/gpx, by primary key, so the (potentially multi-megabyte)
// content never rides along on a route list. Nothing here writes: the file is stored by the
// import tooling, once, and there is deliberately no UPDATE or DELETE — an original is never
// replaced in place.

import { queryOne } from "../db/pool.js";

export interface RouteGpxFile {
  content: Buffer;
  sha256: string;
  byteLength: number;
  filename: string | null;
}

/** Who may read a route's file: the same rule as the route itself (published, or the owner). */
export interface RouteAccessRow {
  ownerId: number | null;
  isPublic: boolean;
}

export async function selectRouteAccess(routeId: number): Promise<RouteAccessRow | null> {
  const row = await queryOne<{ owner_id: number | null; is_public: boolean }>(
    "SELECT owner_id, is_public FROM routes WHERE id = $1",
    [routeId],
  );
  return row ? { ownerId: row.owner_id, isPublic: row.is_public } : null;
}

/**
 * The stored original, or null when this route has none (every route that was not imported) or
 * the table does not exist yet (a database without sql/042). Both mean "fall back to the GPX the
 * client rebuilds", so neither is an error.
 */
export async function selectRouteGpxFile(routeId: number): Promise<RouteGpxFile | null> {
  try {
    const row = await queryOne<{
      content: Buffer;
      sha256: string;
      byte_length: number;
      filename: string | null;
    }>(
      "SELECT content, sha256, byte_length, filename FROM route_gpx_files WHERE route_id = $1",
      [routeId],
    );
    return row
      ? {
          content: row.content,
          sha256: row.sha256,
          byteLength: row.byte_length,
          filename: row.filename,
        }
      : null;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "42P01") return null;
    throw err;
  }
}
