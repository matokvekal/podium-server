// SQL for the ride_images table (sql/052-ride-images-registry.sql, sql/054-ride-images-lifecycle.sql).
// No SQL for this table lives anywhere else.

import { query, queryOne } from "../db/pool.js";
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
  /** sql/054 — 1 on a database without it. Bumped by every Replace. */
  version: number;
  /** sql/054 — false on a database without it. An archived key still resolves for existing rides. */
  archived: boolean;
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
  /** sql/054 — absent on a database without it. */
  version?: number;
  archived?: boolean;
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
    version: row.version ?? 1,
    archived: row.archived ?? false,
  };
}

const LEGACY_COLUMNS = "key, source, selectable, label, category, url, file_name, created_at";
const SELECT_COLUMNS = `${LEGACY_COLUMNS}, version, archived`;

/**
 * Runs a statement with the sql/054 columns and, if the database does not have them yet, once
 * falls back to the pre-054 column list. The catalog is read on every ride create/edit and every
 * card, so deploying this code before the migration must not break any of that.
 */
let lifecycleColumns: boolean | null = null;
async function withColumns<T>(run: (columns: string) => Promise<T>): Promise<T> {
  if (lifecycleColumns === false) return run(LEGACY_COLUMNS);
  try {
    const result = await run(SELECT_COLUMNS);
    lifecycleColumns = true;
    return result;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    lifecycleColumns = false;
    return run(LEGACY_COLUMNS);
  }
}

/** Replace / Archive need the sql/054 columns; thrown when the migration has not run. */
export class RideImageLifecycleUnavailableError extends Error {
  constructor() {
    super("ride_images.version/archived missing — run sql/054-ride-images-lifecycle.sql");
  }
}

/** Every row, static and uploaded, selectable or not, archived or not — what GET
 *  /api/v1/ride-images starts from (a ride wearing an archived key must still resolve it). */
export async function selectAllRideImages(): Promise<RideImageRow[]> {
  return withColumns(async (columns) => {
    const rows = await query<RideImageDbRow>(
      `SELECT ${columns} FROM ride_images ORDER BY created_at ASC`,
    );
    return rows.map(mapRow);
  });
}

export async function selectRideImageByKey(key: string): Promise<RideImageRow | null> {
  return withColumns(async (columns) => {
    const row = await queryOne<RideImageDbRow>(
      `SELECT ${columns} FROM ride_images WHERE key = $1`,
      [key],
    );
    return row ? mapRow(row) : null;
  });
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
  return withColumns(async (columns) => {
    const row = await queryOne<RideImageDbRow>(
      `INSERT INTO ride_images (key, source, selectable, label, category, url, file_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${columns}`,
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
  });
}

export async function updateRideImageSelectable(
  key: string,
  selectable: boolean,
): Promise<RideImageRow | null> {
  return withColumns(async (columns) => {
    const row = await queryOne<RideImageDbRow>(
      `UPDATE ride_images SET selectable = $2 WHERE key = $1 RETURNING ${columns}`,
      [key, selectable],
    );
    return row ? mapRow(row) : null;
  });
}

/** Hides the key from the admin list and the picker; the row (and its file) stay, so every ride
 *  already using it keeps resolving it. sql/054. */
export async function archiveRideImageRow(key: string): Promise<RideImageRow | null> {
  try {
    const row = await queryOne<RideImageDbRow>(
      `UPDATE ride_images SET archived = true, selectable = false, updated_at = now()
        WHERE key = $1 RETURNING ${SELECT_COLUMNS}`,
      [key],
    );
    return row ? mapRow(row) : null;
  } catch (err) {
    if (isMissingColumnError(err)) throw new RideImageLifecycleUnavailableError();
    throw err;
  }
}

/**
 * Points an EXISTING key at a new image and bumps its version. The key never changes. A
 * built-in ('static') key becomes upload-backed here — its build-shipped file is simply no
 * longer referenced. sql/054.
 */
export async function replaceRideImageRow(
  key: string,
  input: { fileName: string; url: string },
): Promise<RideImageRow | null> {
  try {
    const row = await queryOne<RideImageDbRow>(
      `UPDATE ride_images
          SET source = 'upload', file_name = $2, url = $3, version = version + 1, updated_at = now()
        WHERE key = $1 AND archived = false
        RETURNING ${SELECT_COLUMNS}`,
      [key, input.fileName, input.url],
    );
    return row ? mapRow(row) : null;
  } catch (err) {
    if (isMissingColumnError(err)) throw new RideImageLifecycleUnavailableError();
    throw err;
  }
}
