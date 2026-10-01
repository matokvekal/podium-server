// Backfills routes.ai_search_text (sql/057) from the rides that use each route, and marks each
// ride events.route_info_processed = TRUE once its route has been written.
//
//   npm run routes:search-text                                   dry run (default): report, write nothing
//   npm run routes:search-text -- --execute --confirm-db=<name>  write for real
//
// Options
//   --execute            actually write. Without it nothing is ever written.
//   --confirm-db=<name>  REQUIRED with --execute: must equal the connected database's name
//                        (printed by the dry run). Stops a run pointed at the wrong database.
//   --limit=N            stop after N rides (a resumable chunk; the run is idempotent anyway)
//   --samples=N          dry run: print the resulting text of N routes (default 3)
//
// WHAT IT TAKES
//   Rides with route_info_processed = FALSE that have a route (event_routes) AND are publicly
//   listed (visibility 'public', status not draft/cancelled — the GET /events/public rule).
//   Oldest ride first, so the first ride on a route seeds its text.
//   Rides with no route, or not publicly listed, are counted and left untouched (still FALSE).
//
// WHAT IT WRITES — per ride, one transaction (queries/routeSearch.queries.ts):
//   routes.ai_search_text / ai_search_updated_at / ai_search_version — only when the ride adds a
//     line the route does not already have (lib/route-search-text.ts: deduplicated by value)
//   events.route_info_processed = TRUE — only AFTER that route write succeeded
//   A failure rolls back both: the ride stays FALSE and the next run retries it.
//   Nothing else is read or written. No AI, no network.
//
// SAFE TO RE-RUN: only unprocessed rides are selected, and the write re-checks that under a lock.
//
// Target: DATABASE_URL, exactly as the server reads it (a shell variable beats .env). CHECK THE
// HOST printed at the top before --execute — the repo's .env points at production.
//
// Exit code: 0 = ok, 1 = a ride failed, 2 = bad usage or database not ready.
// Compiled form (production box, no tsx): node dist/scripts/backfillRouteSearchText.js

import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { closePool, query, queryOne } from "../db/pool.js";
import {
  applyEventToRouteSearchText,
  buildMergedSearchText,
  type RouteSearchOutcome,
  selectPendingRouteSearchEvents,
  selectRouteSearchBacklog,
  selectRouteSearchRows,
} from "../queries/routeSearch.queries.js";

const BATCH = 100;

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
      limit: { type: "string" },
      samples: { type: "string", default: "3" },
    },
    strict: true,
  });

  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }
  const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit);
  const samples = Number(values.samples);
  if (!(limit >= 1) || !(samples >= 0)) {
    console.error("--limit needs an integer >= 1 and --samples an integer >= 0");
    return 2;
  }

  const dbName = (await queryOne<{ name: string }>("SELECT current_database() AS name"))?.name;
  console.log(`Target: ${describeTarget(env.DATABASE_URL)} / database "${dbName}"`);
  const columns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE (table_name = 'routes' AND column_name IN ('ai_search_text', 'ai_search_updated_at', 'ai_search_version'))
         OR (table_name = 'events' AND column_name = 'route_info_processed')`,
  );
  if (columns.length !== 4) {
    console.error("sql/057-ai-search-prep.sql is not applied on this database — run it first.");
    return 2;
  }
  if (values.execute && values["confirm-db"] !== dbName) {
    console.error(
      `--execute needs --confirm-db=${dbName} (the database this run is connected to).`,
    );
    return 2;
  }
  console.log(values.execute ? "Mode: EXECUTE (writing)" : "Mode: DRY RUN (nothing is written)");

  const backlog = await selectRouteSearchBacklog();
  const line = (label: string, value: string | number) => `${label.padEnd(44)}${value}`;
  console.log("");
  console.log(line("Unprocessed rides to take (public + route):", backlog.eligible));
  console.log(line("  …on distinct routes:", backlog.eligibleRoutes));
  console.log(line("Unprocessed, no route (left FALSE):", backlog.noRoute));
  console.log(line("Unprocessed, not public (left FALSE):", backlog.notPublic));
  console.log("");

  const counts: Record<RouteSearchOutcome | "failed", number> = {
    merged: 0,
    unchanged: 0,
    "already-processed": 0,
    "no-route": 0,
    ineligible: 0,
    "not-found": 0,
    failed: 0,
  };
  const routesTouched = new Set<number>();
  // Dry run only: each route's text as it would stand after the rides seen so far.
  const simulated = new Map<number, string | null>();
  let seen = 0;
  let after: { createdAt: string; id: string } | null = null;

  while (seen < limit) {
    const page = await selectPendingRouteSearchEvents(after, Math.min(BATCH, limit - seen));
    if (page.length === 0) break;
    after = { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].ev.id };

    if (!values.execute) {
      const missing = [...new Set(page.map((p) => p.routeId))].filter((id) => !simulated.has(id));
      const rows = await selectRouteSearchRows(missing);
      for (const id of missing) simulated.set(id, rows.get(id)?.ai_search_text ?? null);
      for (const { ev, routeId } of page) {
        seen += 1;
        const row = rows.get(routeId) ?? { name: null, place_name: null, route_type: null };
        const merged = buildMergedSearchText(
          { ...row, ai_search_text: simulated.get(routeId) ?? null },
          ev,
        );
        if (merged !== null) {
          simulated.set(routeId, merged);
          routesTouched.add(routeId);
          counts.merged += 1;
        } else {
          counts.unchanged += 1;
        }
      }
      continue;
    }

    for (const { ev } of page) {
      seen += 1;
      try {
        const { outcome, routeId } = await applyEventToRouteSearchText(ev.id);
        counts[outcome] += 1;
        if (outcome === "merged" && routeId !== null) routesTouched.add(routeId);
      } catch (err) {
        counts.failed += 1;
        console.error(
          `ride ${ev.id} failed (left unprocessed):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const x = values.execute;
  console.log(line("Rides examined:", seen));
  console.log(line(x ? "Rides that added text:" : "Rides that WOULD add text:", counts.merged));
  console.log(
    line(
      x ? "Rides that added nothing new:" : "Rides that WOULD add nothing new:",
      counts.unchanged,
    ),
  );
  console.log(
    line(x ? "Routes whose text changed:" : "Routes whose text WOULD change:", routesTouched.size),
  );
  console.log(
    line(
      x ? "Rides marked processed:" : "Rides that WOULD be marked processed:",
      counts.merged + counts.unchanged,
    ),
  );
  if (values.execute) {
    const skipped =
      counts["already-processed"] + counts["no-route"] + counts.ineligible + counts["not-found"];
    console.log(line("Skipped (changed meanwhile):", skipped));
    console.log(line("Failed (left unprocessed):", counts.failed));
  }

  if (!values.execute && samples > 0) {
    const shown = [...routesTouched].slice(0, samples);
    for (const id of shown) {
      console.log("");
      console.log(`── route ${id} ──`);
      console.log(simulated.get(id));
    }
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
