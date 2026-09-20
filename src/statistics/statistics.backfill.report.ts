// Plain-text rendering of a BackfillReport — kept apart from the CLI so it can be tested without
// touching a database.

import type { BackfillReport } from "./statistics.backfill.js";

const MAX_IDS_SHOWN = 50;

function rows(label: string, counts: BackfillReport["months"], verb: string): string {
  return `  ${label.padEnd(22)} ${verb} ${counts.create} new, ${counts.update} changed, ${counts.unchanged} left as is`;
}

export function formatBackfillReport(report: BackfillReport): string {
  const execute = report.mode === "execute";
  const toPast = execute ? "written:" : "would write:";
  const lines: string[] = [
    `Statistics history backfill — ${execute ? "EXECUTED" : "DRY RUN (nothing written)"}`,
    `  generated                ${report.generatedAt}`,
    `  check-in rule            ${
      report.checkInRequiredFrom
        ? `required for rides started on/after ${report.checkInRequiredFrom}; earlier rides count on registration`
        : "not applied (registration alone counts)"
    }`,
    `  overwrite existing rows  ${report.onlyMissing ? "no (--only-missing)" : "yes, when the numbers differ"}`,
    "",
    `  riders found             ${report.ridersFound}`,
    `  riders excluded          ${report.ridersExcluded.count}${
      report.ridersExcluded.count > 0
        ? `  (ids: ${report.ridersExcluded.userIds.slice(0, MAX_IDS_SHOWN).join(", ")}${
            report.ridersExcluded.count > MAX_IDS_SHOWN ? ", ..." : ""
          })`
        : ""
    }`,
    `  riders ${execute ? "processed" : "to process"}       ${report.ridersProcessed}`,
    `  riders w/o counted rides ${report.ridersWithoutCountedRides}`,
    `  rides considered         ${report.ridesConsidered}`,
    "",
    rows("monthly statistics", report.months, toPast),
    rows("yearly statistics", report.years, toPast),
    rows("lifetime/year cache", report.cacheRows, toPast),
    "",
    "  participations NOT counted, by reason:",
    ...(report.ignored.length === 0
      ? ["    (none)"]
      : report.ignored.map(
          (row) => `    ${String(row.participations).padStart(7)}  ${row.reason}`,
        )),
  ];
  if (report.warnings.length > 0) {
    lines.push("", "  WARNINGS:", ...report.warnings.map((w) => `    - ${w}`));
  }
  lines.push("", `  failures                 ${report.failures.length}`);
  for (const failure of report.failures.slice(0, MAX_IDS_SHOWN)) {
    lines.push(`    user ${failure.userId}: ${failure.error}`);
  }
  if (report.lastUserId !== null) {
    lines.push(
      "",
      `  last rider id reached    ${report.lastUserId}  (resume: --after-user-id=${report.lastUserId})`,
    );
  }
  return lines.join("\n");
}
