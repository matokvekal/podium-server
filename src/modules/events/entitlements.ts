// The seam for per-owner plan limits. Today there is only one flat free-tier limit, sourced
// from env — no plan/billing concept exists yet (see plan/02-database-schema.md). Once paid
// plans exist, this function becomes the one place that looks up an owner's plan/entitlement
// instead of returning the flat default; callers (event.service.ts) don't need to change.

import { env } from "../../config/env.js";

export function getMaxConcurrentLiveEvents(_ownerId: number): number {
  return env.MAX_CONCURRENT_LIVE_EVENTS_FREE;
}
