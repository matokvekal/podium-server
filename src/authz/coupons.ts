// Coupon redemption.
//
// Exists now specifically for the beta plan: "we will use many free Premium coupons with
// expiration dates, so early users are not paying while the product is still receiving
// significant fixes and improvements." Handing out Pro for 90 days is one row in `coupons`.
//
// A coupon is not a plan and not a grant — it is a *way of creating* a grant. Keeping the
// three separate is what lets a subscription, a coupon and a support override all end up as
// the same kind of row without the policy knowing which is which.

import { queryOne, withTransaction } from "../db/pool.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import type { Feature } from "./capabilities.js";
import { FEATURES } from "./capabilities.js";
import { isPlanCode, type PlanCode } from "./plans.js";

interface CouponRow {
  code: string;
  plan_code: string | null;
  feature: string | null;
  quantity: number | null;
  grant_days: number | null;
  grant_until: Date | null;
  max_redemptions: number | null;
  redeemed_count: number;
  valid_from: Date;
  valid_until: Date | null;
}

export interface RedemptionResult {
  grantId: number;
  planCode: PlanCode | null;
  feature: Feature | null;
  expiresAt: Date | null;
}

/**
 * Two different clocks, deliberately: `valid_from`/`valid_until` say when the COUPON works,
 * `grant_days`/`grant_until` say how long the GRANT it creates lasts. A campaign that runs
 * through March can still hand out 90 days of access on the last day of it.
 */
function grantExpiry(coupon: CouponRow, now: Date): Date | null {
  if (coupon.grant_until !== null) return coupon.grant_until;
  if (coupon.grant_days !== null) {
    return new Date(now.getTime() + coupon.grant_days * 24 * 60 * 60 * 1000);
  }
  return null; // no expiry — a permanent grant
}

/**
 * Whole redemption in one transaction, and the redemption row is inserted BEFORE the counter
 * moves: the primary key on (coupon_code, user_id) is what makes "one per person" true under
 * concurrency, rather than a count that two requests can both read.
 */
export async function redeemCoupon(userId: number, rawCode: string): Promise<RedemptionResult> {
  const code = rawCode.trim().toUpperCase();

  return withTransaction(async (tx) => {
    const coupon = await tx.queryOne<CouponRow>(
      "SELECT * FROM coupons WHERE code = $1 FOR UPDATE",
      [code],
    );
    // One message for "no such coupon" and for "expired": a redemption endpoint must not
    // become an oracle for guessing valid codes.
    if (!coupon) throw new ApiError(404, "That code is not valid");

    const now = new Date();
    if (coupon.valid_from > now) throw new ApiError(404, "That code is not valid");
    if (coupon.valid_until !== null && coupon.valid_until <= now) {
      throw new ApiError(410, "That code has expired");
    }
    if (coupon.max_redemptions !== null && coupon.redeemed_count >= coupon.max_redemptions) {
      throw new ApiError(410, "That code has been fully redeemed");
    }

    const alreadyRedeemed = await tx.queryOne<{ user_id: number }>(
      "SELECT user_id FROM coupon_redemptions WHERE coupon_code = $1 AND user_id = $2",
      [code, userId],
    );
    if (alreadyRedeemed) throw new ApiError(409, "You have already used that code");

    const expiresAt = grantExpiry(coupon, now);
    const grant = await tx.queryOne<{ id: number }>(
      `INSERT INTO entitlement_grants
          (user_id, plan_code, feature, quantity, source, source_ref, expires_at)
        VALUES ($1, $2, $3, $4, 'coupon', $5, $6)
        RETURNING id`,
      [userId, coupon.plan_code, coupon.feature, coupon.quantity, code, expiresAt],
    );
    if (!grant) throw new Error("redeemCoupon: grant insert returned no row");

    await tx.query(
      "INSERT INTO coupon_redemptions (coupon_code, user_id, grant_id) VALUES ($1, $2, $3)",
      [code, userId, grant.id],
    );
    await tx.query("UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = $1", [
      code,
    ]);

    logger.info({ userId, code, grantId: grant.id, expiresAt }, "coupon redeemed");
    return {
      grantId: grant.id,
      planCode: coupon.plan_code !== null && isPlanCode(coupon.plan_code) ? coupon.plan_code : null,
      feature:
        coupon.feature !== null && (FEATURES as readonly string[]).includes(coupon.feature)
          ? (coupon.feature as Feature)
          : null,
      expiresAt,
    };
  });
}

/** Admin/support helper. There is no endpoint for this yet — coupons are created by hand. */
export async function createCoupon(input: {
  code: string;
  planCode?: PlanCode;
  feature?: Feature;
  quantity?: number;
  grantDays?: number;
  grantUntil?: Date;
  maxRedemptions?: number;
  validUntil?: Date;
  note?: string;
}): Promise<void> {
  await queryOne(
    `INSERT INTO coupons
        (code, plan_code, feature, quantity, grant_days, grant_until, max_redemptions,
         valid_until, note)
      VALUES (UPPER($1), $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING code`,
    [
      input.code,
      input.planCode ?? null,
      input.feature ?? null,
      input.quantity ?? null,
      input.grantDays ?? null,
      input.grantUntil ?? null,
      input.maxRedemptions ?? null,
      input.validUntil ?? null,
      input.note ?? null,
    ],
  );
}
