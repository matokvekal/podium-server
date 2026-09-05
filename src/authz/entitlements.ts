// Grants → { plan, features, limits }. The ONLY reader of entitlement_grants.
//
// Everything else in the codebase asks the policy for a capability or asks for a limit; nobody
// else looks at a grant, a source, or an expiry. That is the whole point: subscriptions,
// coupons, trials, one-time purchases and support overrides all arrive here as rows, and
// resolution folds them into one answer that the rest of the product can use without knowing
// which of those it came from.

import type { EffectiveLimits } from "../config/plan-limits.js";
import { query, type Transaction, withTransaction } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { isAppFlagOn } from "../queries/appFlags.queries.js";
import { applyPlanLimitsTx, selectUserLimitsOrThrow } from "../queries/userLimits.queries.js";
import type { Feature } from "./capabilities.js";
import { FEATURES } from "./capabilities.js";
import type { PlanLimits } from "./plans.js";
import { isPlanCode, mergeLimits, PLANS, type PlanCode, type PlanDefinition } from "./plans.js";

export const GRANT_SOURCES = ["subscription", "coupon", "purchase", "trial", "manual"] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

interface GrantRow {
  id: number;
  user_id: number;
  plan_code: string | null;
  feature: string | null;
  quantity: number | null;
  consumed: number;
  scope_type: string | null;
  scope_id: string | null;
  source: GrantSource;
  source_ref: string | null;
  starts_at: Date;
  expires_at: Date | null;
}

/** What a grant is, flattened for the client and for support. Never used by the policy. */
export interface GrantSummary {
  id: number;
  planCode: string | null;
  feature: string | null;
  source: GrantSource;
  expiresAt: Date | null;
  /** Remaining uses on a consumable grant; null when it is not consumable. */
  remaining: number | null;
}

export interface Entitlements {
  /** The highest-ranked active plan. `free` when nothing else applies. */
  plan: PlanDefinition;
  features: ReadonlySet<Feature>;
  limits: PlanLimits;
  /** For the account screen and for support. Not an authorization input. */
  grants: GrantSummary[];
}

/** A signed-out caller. Free limits, no features — and never a database round trip. */
export const ANONYMOUS_ENTITLEMENTS: Entitlements = {
  plan: PLANS.free,
  features: new Set<Feature>(),
  limits: PLANS.free.limits,
  grants: [],
};

function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/**
 * Live = started, not expired, not revoked, and (if consumable) not used up.
 *
 * `scope_type IS NULL` filters to account-wide grants: an event-scoped grant belongs to that
 * one ride and must not quietly upgrade the whole account.
 */
const LIVE_GRANTS_SQL = `SELECT * FROM entitlement_grants
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND starts_at <= NOW()
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (quantity IS NULL OR consumed < quantity)
          AND scope_type IS NULL
        ORDER BY id ASC`;

async function selectLiveGrants(userId: number): Promise<GrantRow[]> {
  try {
    return await query<GrantRow>(LIVE_GRANTS_SQL, [userId]);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    // Older local DBs may not have authz tables yet. Fall back to the free plan rather than
    // failing /users/me and blocking sign-in.
    //
    // ⚠ This is NOT a limits fallback and cannot become one: limits come from user_limits,
    // which is read separately and throws when absent. Losing this table costs the caller
    // their plan LABEL and their FEATURE set, never their numbers.
    if (code === "42P01") {
      logger.warn({ userId, err }, "entitlement tables missing; falling back to free entitlements");
      return [];
    }
    throw err;
  }
}

export async function resolveEntitlements(userId: number | null): Promise<Entitlements> {
  if (userId === null) return ANONYMOUS_ENTITLEMENTS;

  // Two independent sources, one round trip: what the user was GRANTED (a plan, features)
  // and what has been set for them SPECIFICALLY (user_limits). But they answer DIFFERENT
  // questions: grants decide the plan label and the feature set, user_limits decides the
  // numbers and is the only thing consulted for them.
  const [rows, limits, creationOpenToAll] = await Promise.all([
    selectLiveGrants(userId),
    selectUserLimitsOrThrow(userId),
    // A single global switch an operator flips in psql — sql/029-app-flags.sql. When on, ride
    // creation is open to everyone exactly as it was before sql/027 gated it.
    isAppFlagOn("event_creation_open_to_all"),
  ]);

  const activePlans: PlanDefinition[] = [];
  const features = new Set<Feature>();
  const grants: GrantSummary[] = [];

  // The global "open to all" switch grants create_events to every signed-in account, on top of
  // whatever their plan and grants already give them. Turning it off later removes only this
  // blanket access — a per-account create_events grant is untouched.
  if (creationOpenToAll) features.add("create_events");

  for (const row of rows) {
    grants.push({
      id: row.id,
      planCode: row.plan_code,
      feature: row.feature,
      source: row.source,
      expiresAt: row.expires_at,
      remaining: row.quantity === null ? null : row.quantity - row.consumed,
    });

    if (row.plan_code !== null) {
      // An unknown plan code is ignored rather than fatal: a grant written by a newer deploy,
      // or a tier that was retired, must not lock someone out of their account.
      if (isPlanCode(row.plan_code)) activePlans.push(PLANS[row.plan_code]);
      else logger.warn({ userId, planCode: row.plan_code }, "unknown plan code on grant");
      continue;
    }
    if (row.feature !== null && isFeature(row.feature)) features.add(row.feature);
  }

  // Highest rank wins the "which plan am I on" question — a beta coupon on top of a paid
  // subscription must never demote the subscriber.
  const plan = activePlans.reduce(
    (best, candidate) => (candidate.rank > best.rank ? candidate : best),
    PLANS.free,
  );
  for (const feature of plan.features) features.add(feature);

  return {
    plan,
    features,
    // The row, verbatim. No merge with the plan, no coalesce, no default — user_limits IS
    // the answer. A plan only ever reaches a user by having been COPIED into this row when
    // the grant was written (syncUserLimitsFromGrantsTx), which is what lets the request path
    // stay a single indexed lookup and never reason about grants at all.
    limits,
    grants,
  };
}

/**
 * Spend one use of a consumable grant, e.g. the one-time private-event purchase.
 *
 * Conditional UPDATE rather than read-then-write: two concurrent creations must not both spend
 * the same credit, and `consumed < quantity` in the WHERE clause is what makes that atomic.
 * Returns the grant id that paid, or null when the caller had nothing to spend — a plan
 * feature is not consumable, so callers check the feature first and only come here to bill it.
 */
export async function consumeFeatureCredit(
  userId: number,
  feature: Feature,
  scope?: { type: string; id: string },
): Promise<number | null> {
  return withTransaction(async (tx) => {
    const row = await tx.queryOne<{ id: number }>(
      `UPDATE entitlement_grants
          SET consumed = consumed + 1, updated_at = NOW()
        WHERE id = (
          SELECT id FROM entitlement_grants
           WHERE user_id = $1
             AND feature = $2
             AND quantity IS NOT NULL
             AND consumed < quantity
             AND revoked_at IS NULL
             AND starts_at <= NOW()
             AND (expires_at IS NULL OR expires_at > NOW())
             AND scope_type IS NULL
           ORDER BY expires_at ASC NULLS LAST, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [userId, feature],
    );
    if (!row) return null;

    // Pin the spent credit to what it bought, so a refund or a support question can see it.
    if (scope) {
      await tx.query(
        `INSERT INTO entitlement_grants
            (user_id, feature, scope_type, scope_id, source, source_ref)
          VALUES ($1, $2, $3, $4, 'purchase', $5)`,
        [userId, feature, scope.type, scope.id, `grant:${row.id}`],
      );
    }
    return row.id;
  });
}

export interface NewGrant {
  userId: number;
  planCode?: PlanCode;
  feature?: Feature;
  quantity?: number;
  source: GrantSource;
  sourceRef?: string;
  expiresAt?: Date | null;
}

/**
 * Recompute which plan a user is on from their live grants, and COPY that plan's numbers into
 * user_limits. This is the bridge that keeps plans meaningful now that the request path reads
 * user_limits and nothing else.
 *
 * Runs inside the caller's transaction so a grant and the limits it implies commit together.
 * With no live plan grant this writes the FREE numbers back — which is what makes it correct
 * for a downgrade or a revocation as well as an upgrade.
 *
 * ⚠ Expiry is the open edge. A grant with an `expires_at` stops being live on its own, with
 * nobody writing a row, so the user keeps the elevated numbers until something calls this
 * again. A sweeper is needed before timed plans are sold.
 */
export async function syncUserLimitsFromGrantsTx(tx: Transaction, userId: number): Promise<void> {
  const rows = await tx.query<GrantRow>(LIVE_GRANTS_SQL, [userId]);

  const activePlans: PlanDefinition[] = [];
  for (const row of rows) {
    if (row.plan_code !== null && isPlanCode(row.plan_code)) activePlans.push(PLANS[row.plan_code]);
  }

  const plan = activePlans.reduce(
    (best, candidate) => (candidate.rank > best.rank ? candidate : best),
    PLANS.free,
  );
  // Most generous per limit across every plan held, so a beta coupon stacked on a subscription
  // never leaves someone worse off than either alone. This is the ONE place that still merges
  // plans — and its output is written to the row, not returned to a request.
  const limits: EffectiveLimits = mergeLimits([plan, ...activePlans]);

  await applyPlanLimitsTx(tx, userId, limits, `plan:${plan.code}`);
}

/**
 * The single write path. Billing, coupons and support all land here.
 *
 * Transactional because a plan grant now has to move user_limits too: writing the grant alone
 * would leave a paying user on numbers the runtime still reads as free.
 */
export async function grantEntitlement(input: NewGrant): Promise<number> {
  const row = await withTransaction(async (tx) => {
    const inserted = await tx.queryOne<{ id: number }>(
      `INSERT INTO entitlement_grants
          (user_id, plan_code, feature, quantity, source, source_ref, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
      [
        input.userId,
        input.planCode ?? null,
        input.feature ?? null,
        input.quantity ?? null,
        input.source,
        input.sourceRef ?? null,
        input.expiresAt ?? null,
      ],
    );
    if (!inserted) throw new Error("grantEntitlement returned no row");

    // Only a PLAN changes the numbers. A feature-only grant (a private-ride credit) leaves
    // user_limits alone — rewriting it would stamp a support override back to the plan value.
    if (input.planCode) await syncUserLimitsFromGrantsTx(tx, input.userId);

    return inserted;
  });
  logger.info(
    {
      userId: input.userId,
      planCode: input.planCode,
      feature: input.feature,
      source: input.source,
    },
    "entitlement granted",
  );
  return row.id;
}
