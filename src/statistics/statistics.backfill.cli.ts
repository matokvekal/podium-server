// CLI for the Statistics history backfill — see statistics.backfill.ts for what it does and why
// it is safe to re-run.
//
//   npm run stats:backfill                                   dry run (default): report, write nothing
//   npm run stats:backfill -- --execute --confirm-db=<name>  write for real
//
// Options
//   --execute              actually write. Without it nothing is ever written.
//   --confirm-db=<name>    REQUIRED with --execute: must equal the connected database's name
//                          (printed by the dry run). Stops a run pointed at the wrong database.
//   --user-id=1,2,3        only these accounts (still subject to exclusion)
//   --after-user-id=N      resume: only accounts with id > N (the previous run printed its last id)
//   --limit=N              at most N accounts this run (a resumable chunk)
//   --only-missing         create absent rows only; never overwrite an existing one
//   --json                 print the report as JSON on stdout (progress goes to stderr)
//
// Exit code: 0 = ok, 1 = some rider failed / run aborted, 2 = bad usage or database not ready.
// Compiled form (production box, no tsx): node dist/statistics/statistics.backfill.cli.js

import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { closePool, query } from "../db/pool.js";
import { runStatsBackfill } from "./statistics.backfill.js";
import { selectMissingSchema } from "./statistics.backfill.queries.js";
import { formatBackfillReport } from "./statistics.backfill.report.js";

function parseIdList(raw: string | undefined, flag: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((part) => Number(part.trim()));
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`${flag} needs a comma-separated list of positive integers`);
  }
  return ids;
}

function parsePositiveInt(raw: string | undefined, flag: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`${flag} needs an integer >= ${min}`);
  return value;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      "confirm-db": { type: "string" },
      "user-id": { type: "string" },
      "after-user-id": { type: "string" },
      limit: { type: "string" },
      "only-missing": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }
  const filter = {
    userIds: parseIdList(values["user-id"], "--user-id"),
    afterUserId: parsePositiveInt(values["after-user-id"], "--after-user-id", 0),
    limit: parsePositiveInt(values.limit, "--limit", 1),
  };

  const [target] = await query<{ db: string }>("SELECT current_database() AS db");
  const host = new URL(env.DATABASE_URL).hostname;
  console.error(`Target database: ${target.db} on ${host} (NODE_ENV=${env.NODE_ENV})`);

  const missing = await selectMissingSchema();
  if (missing.length > 0) {
    console.error(
      `This database is not ready. Run these migrations first:\n  - ${missing.join("\n  - ")}`,
    );
    return 2;
  }

  if (values.execute && values["confirm-db"] !== target.db) {
    console.error(
      `Refusing to write. Pass --confirm-db=${target.db} to confirm this is the database you mean.`,
    );
    return 2;
  }

  const report = await runStatsBackfill({
    execute: values.execute,
    onlyMissing: values["only-missing"],
    filter,
    onProgress: (line) => console.error(line),
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatBackfillReport(report));
  return report.failures.length > 0 || report.aborted ? 1 : 0;
}

// exitCode rather than process.exit(): lets the logger and the pool finish flushing first.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  })
  .finally(() => closePool().catch(() => {}));
