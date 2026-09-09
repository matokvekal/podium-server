// trackAuditEvent — the ONLY entry point business code should call.
//
// It is non-fatal by construction: every error is caught and logged, nothing is rethrown. A
// caller does `void trackAuditEvent({ ... })` after its business action has already succeeded,
// and whether the analytics row is written or not, the business flow is unaffected.
//
//   ride created  ->  analytics insert fails  ->  ride creation STILL succeeds
//
// Tolerated failure modes, all → warn + continue:
//   * analytics_events does not exist yet (42P01 — code deployed before sql/031 was run)
//   * the insert fails / the DB is briefly unavailable for it
//   * anything else this module throws
//
// This mirrors the pattern already used for a table that may predate its migration —
// selectLiveGrants (authz/entitlements.ts) and getAppFlag (queries/appFlags.queries.ts).

import { logger } from "../../lib/logger.js";
import { insertAnalyticsEvent } from "./audit.queries.js";
import type { AuditEvent } from "./audit.types.js";

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code?.toString()
    : undefined;
}

export async function trackAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await insertAnalyticsEvent(event);
  } catch (err) {
    if (errorCode(err) === "42P01") {
      // Table missing — the code shipped before sql/031-analytics-events.sql was applied.
      logger.warn(
        { eventType: event.type },
        "analytics_events missing — run sql/031-analytics-events.sql; analytics skipped",
      );
      return;
    }
    logger.warn({ err, eventType: event.type }, "analytics event not recorded (non-fatal)");
  }
}
