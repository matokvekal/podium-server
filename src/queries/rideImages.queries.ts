// SQL for the ride_images table (sql/052-ride-images-registry.sql). No SQL for this table lives
// anywhere else.

import { execute, query, queryOne } from "../db/pool.js";
import { isMissingColumnError } from "./event.queries.js";

export type RideImageSource = "static" | "upload";

export interface RideImageRow {
  key: string;
  source: RideImageSource;
  selectable: boolean;
  label: string;
  category: string;
  url: string;
  fileName: string | null;
  createdAt: Date;
}

interface RideImageDbRow {
  key: string;
  source: RideImageSource;
  selectable: boolean;
  label: string;
  category: string;
  url: string;
  file_name: string | null;
  created_at: Date;
}

function mapRow(row: RideImageDbRow): RideImageRow {
  return {
    key: row.key,
    source: row.source,
    selectable: row.selectable,
    label: row.label,
    category: row.category,
    url: row.url,
    fileName: row.file_name,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = "key, source, selectable, label, category, url, file_name, created_at";

/** Every row, static and uploaded, selectable or not — what GET /api/v1/ride-images (any
 *  authenticated user) and the admin table both start from. Ordered so the picker's grouping
 *  reads stably: oldest first within a category is not guaranteed by this alone, callers group
 *  client-side. */
export async function selectAllRideImages(): Promise<RideImageRow[]> {
  const rows = await query<RideImageDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM ride_images ORDER BY created_at ASC`,
  );
  return rows.map(mapRow);
}

export async function selectRideImageByKey(key: string): Promise<RideImageRow | null> {
  const row = await queryOne<RideImageDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM ride_images WHERE key = $1`,
    [key],
  );
  return row ? mapRow(row) : null;
}

export async function rideImageKeyExists(key: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>("SELECT 1 AS one FROM ride_images WHERE key = $1", [
    key,
  ]);
  return row !== null;
}

export interface InsertRideImageInput {
  key: string;
  source: RideImageSource;
  selectable: boolean;
  label: string;
  category: string;
  url: string;
  fileName: string | null;
}

export async function insertRideImage(input: InsertRideImageInput): Promise<RideImageRow> {
  const row = await queryOne<RideImageDbRow>(
    `INSERT INTO ride_images (key, source, selectable, label, category, url, file_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.key,
      input.source,
      input.selectable,
      input.label,
      input.category,
      input.url,
      input.fileName,
    ],
  );
  // INSERT ... RETURNING on a fresh insert always yields exactly one row; a null here would
  // mean the statement itself failed, which throws before this line is reached.
  return mapRow(row as RideImageDbRow);
}

export async function updateRideImageSelectable(
  key: string,
  selectable: boolean,
): Promise<RideImageRow | null> {
  const row = await queryOne<RideImageDbRow>(
    `UPDATE ride_images SET selectable = $2 WHERE key = $1 RETURNING ${SELECT_COLUMNS}`,
    [key, selectable],
  );
  return row ? mapRow(row) : null;
}

export async function deleteRideImageRow(key: string): Promise<boolean> {
  const affected = await execute("DELETE FROM ride_images WHERE key = $1", [key]);
  return affected > 0;
}

/** How many events currently reference this key — the gate that keeps DELETE from ever
 *  orphaning a ride's cover. Guarded against a database predating sql/051 the same way
 *  updateEventRideImage is: a missing column reads as "nothing references it" rather than a
 *  500, since a database without the column cannot have any ride using this key either. */
export async function countEventsUsingRideImage(key: string): Promise<number> {
  try {
    const row = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE ride_image_key = $1",
      [key],
    );
    return row ? Number(row.count) : 0;
  } catch (err) {
    if (isMissingColumnError(err)) return 0;
    throw err;
  }
}
