// SQL for a track's flyover video metadata — route_videos (sql/058). The bytes are on disk
// (lib/route-video-storage.ts); this table only says "this route has a video, of this type, this
// long". Reads treat a database without the table (42P01) as "no video", the same graceful
// fallback routeGpx.queries.ts uses for route_gpx_files.

import type { RouteVideoExt } from "../config/route-videos.js";
import { execute, queryOne } from "../db/pool.js";

export interface RouteVideoMeta {
  ext: RouteVideoExt;
  byteLength: number;
  durationS: number | null;
  updatedAt: Date;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

export async function selectRouteVideo(routeId: number): Promise<RouteVideoMeta | null> {
  try {
    const row = await queryOne<{
      ext: RouteVideoExt;
      byte_length: number;
      duration_s: number | null;
      updated_at: Date;
    }>("SELECT ext, byte_length, duration_s, updated_at FROM route_videos WHERE route_id = $1", [
      routeId,
    ]);
    return row
      ? {
          ext: row.ext,
          byteLength: row.byte_length,
          durationS: row.duration_s,
          updatedAt: row.updated_at,
        }
      : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export async function upsertRouteVideo(
  routeId: number,
  input: { ext: RouteVideoExt; byteLength: number; durationS: number | null },
): Promise<RouteVideoMeta> {
  const row = await queryOne<{ updated_at: Date }>(
    `INSERT INTO route_videos (route_id, ext, byte_length, duration_s, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (route_id) DO UPDATE
        SET ext = EXCLUDED.ext,
            byte_length = EXCLUDED.byte_length,
            duration_s = EXCLUDED.duration_s,
            updated_at = NOW()
     RETURNING updated_at`,
    [routeId, input.ext, input.byteLength, input.durationS],
  );
  if (!row) throw new Error("upsertRouteVideo returned no row");
  return { ...input, updatedAt: row.updated_at };
}

export async function deleteRouteVideoRow(routeId: number): Promise<void> {
  await execute("DELETE FROM route_videos WHERE route_id = $1", [routeId]);
}

/** True when some ride uses this route — a ride's viewers may watch its track video even when the
 *  track itself is not published to the library. */
export async function isRouteAttachedToEvent(routeId: number): Promise<boolean> {
  const row = await queryOne<{ attached: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM event_routes WHERE route_id = $1) AS attached",
    [routeId],
  );
  return row?.attached === true;
}
