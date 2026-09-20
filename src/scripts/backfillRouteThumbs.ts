// Backfills routes.thumb_points (sql/046) — the 60-point card preview — for routes that have none.
//
//   npm run routes:thumbs                                   dry run (default): report, write nothing
//   npm run routes:thumbs -- --execute --confirm-db=<name>  write for real
//
// Options
//   --execute            actually write. Without it nothing is ever written.
//   --confirm-db=<name>  REQUIRED with --execute: must equal the connected database's name
//                        (printed by the dry run). Stops a run pointed at the wrong database.
//   --recompute          also rebuild routes that already have a thumb_points (default: only NULLs)
//   --limit=N            stop after N routes (a resumable chunk; the run is idempotent anyway)
//
// WHAT IT READS AND WRITES
//   Reads routes.track_points — the stored display line — and nothing else. It never touches
//   route_gpx_files (the original GPX), preview_points, track_points, events, or any other table.
//   Writes routes.thumb_points only, and does not bump updated_at: a preview is derived data, not
//   an edit to the route.
//
// SAFE TO RE-RUN: only routes with a NULL thumb_points are selected, and each UPDATE repeats that
// condition, so a second run (or a route written by the app in between) is left alone.
//
// Target: DATABASE_URL, exactly as the server reads it (a shell variable beats .env). CHECK THE
// HOST printed at the top before --execute — the repo's .env points at production.
//
// Exit code: 0 = ok, 1 = a route failed / run aborted, 2 = bad usage or database not ready.
// Compiled form (production box, no tsx): node dist/scripts/backfillRouteThumbs.js

import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { closePool, execute, query, queryOne } from "../db/pool.js";
import { previewFromStored, toStoredThumb } from "../lib/route-thumb.js";

const BATCH = 100;

interface Row {
  id: number;
  track_points: unknown;
}

function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      "confirm-db": { type: "string" },
      recompute: { type: "boolean", default: false },
      limit: { type: "string" },
    },
    strict: true,
  });

  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }
  const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit);
  if (!(limit >= 1)) {
    console.error("--limit needs an integer >= 1");
    return 2;
  }

  const dbName = (await queryOne<{ name: string }>("SELECT current_database() AS name"))?.name;
  const hasColumn = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'routes' AND column_name = 'thumb_points'`,
  );
  console.log(`Target: ${describeTarget(env.DATABASE_URL)} / database "${dbName}"`);
  if (!hasColumn) {
    console.error("routes.thumb_points does not exist — run sql/046-route-thumb.sql first.");
    return 2;
  }
  if (values.execute && values["confirm-db"] !== dbName) {
    console.error(
      `--execute needs --confirm-db=${dbName} (the database this run is connected to).`,
    );
    return 2;
  }
  console.log(values.execute ? "Mode: EXECUTE (writing)" : "Mode: DRY RUN (nothing is written)");

  const counts = { seen: 0, written: 0, noLine: 0, failed: 0, skippedRace: 0 };
  let totalBytes = 0;
  let maxBytes = 0;
  let totalPoints = 0;
  let withElevation = 0;
  let lastId = 0;

  while (counts.seen < limit) {
    const rows = await query<Row>(
      `SELECT id, track_points
         FROM routes
        WHERE id > $1 ${values.recompute ? "" : "AND thumb_points IS NULL"}
        ORDER BY id
        LIMIT $2`,
      [lastId, Math.min(BATCH, limit - counts.seen)],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      counts.seen += 1;
      try {
        const preview = previewFromStored(row.track_points);
        const stored = toStoredThumb(preview);
        if (!preview || !stored) {
          counts.noLine += 1; // fewer than two usable points — nothing to draw, nothing to store
          continue;
        }
        const json = JSON.stringify(stored);
        totalBytes += json.length;
        maxBytes = Math.max(maxBytes, json.length);
        totalPoints += preview.points.length;
        if (preview.elevations) withElevation += 1;

        if (values.execute) {
          const changed = await execute(
            `UPDATE routes SET thumb_points = $2::jsonb
              WHERE id = $1 ${values.recompute ? "" : "AND thumb_points IS NULL"}`,
            [row.id, json],
          );
          if (changed === 0) counts.skippedRace += 1;
          else counts.written += 1;
        } else {
          counts.written += 1; // "would write"
        }
      } catch (err) {
        counts.failed += 1;
        console.error(`route ${row.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const built = counts.written + counts.skippedRace;
  const line = (label: string, value: string | number) => `${label.padEnd(34)}${value}`;
  console.log("");
  console.log(line("Routes examined:", counts.seen));
  console.log(
    line(
      values.execute ? "Thumbnails written:" : "Thumbnails that WOULD be written:",
      counts.written,
    ),
  );
  console.log(line("No drawable line (skipped):", counts.noLine));
  console.log(line("Failed:", counts.failed));
  if (values.execute) console.log(line("Skipped (changed meanwhile):", counts.skippedRace));
  if (built > 0) {
    console.log(
      line(
        "Preview size:",
        `avg ${Math.round(totalBytes / built)} B, max ${maxBytes} B JSON; avg ${(totalPoints / built).toFixed(1)} points; ${withElevation} with elevation`,
      ),
    );
  }
  console.log("");
  console.log(
    values.execute ? "Done." : "Dry run only. Re-run with --execute --confirm-db=<name> to write.",
  );
  return counts.failed > 0 ? 1 : 0;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 2;
} finally {
  await closePool();
}
process.exit(code);
