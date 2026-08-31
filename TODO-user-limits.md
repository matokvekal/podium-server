# user_limits — handover

**Status as of 2026-08-31.** Production database is migrated. **Server code is written but NOT
deployed and NOT committed.**

---

## The design, in one line

`user_limits` is the single runtime source of truth. ENV/config is a template used once when a
row is created; it is never a runtime fallback. No row = `UserLimitsNotFoundError`, not a
silent free tier.

```
ENV/config ──(once, at signup)──> user_limits ──(every request)──> limit check
plan grant ──(writes the row)────────^
```

---

## DONE — production database

| Migration | Applied by | Result |
|---|---|---|
| `018-user-limits.sql` | the user (not Claude) | `user_limits` created, OLD nullable shape |
| `020-production-schema-gaps.sql` | the user (not Claude) | `client_actions.response_status/_body`, `coupons`, `coupon_redemptions` |
| `019-user-limits-backfill.sql` | Claude, with approval | 5 users → 5 rows @ `3/50/2/2`, all four columns `NOT NULL` |

Verified on `191.215.39.19:5432/elnino`:

```
users = 5   user_limits = 5   users without limits = 0   rows with NULL limits = 0
events_per_week / participants_per_event / groups_per_event / teams_owned : is_nullable = NO
```

The DB is ready for the new code. Deploying it cannot lock anyone out.

---

## DONE — code (uncommitted, on `main`)

Modified: `src/config/env.ts` (+4 `DEFAULT_*` vars), `src/config/plan-limits.ts` (rewritten),
`src/queries/userLimits.queries.ts` (rewritten), `src/authz/entitlements.ts`,
`src/authz/plans.ts`, `src/authz/coupons.ts`, `src/queries/user.queries.ts`,
`sql/018-user-limits.sql`, `sql/README.md` (resolved a merge conflict that had dropped half
the migration table).

New: `sql/019-user-limits-backfill.sql`, `sql/020-production-schema-gaps.sql`, and four test
files (`authz/entitlements.test.ts`, `authz/limits.test.ts`, `queries/user.queries.test.ts`,
`queries/userLimits.queries.test.ts`).

38 new tests, 101 total, all passing. `tsc --noEmit` clean, `biome check` clean.

Fallbacks removed: the `42P01` swallow in `selectUserLimits`; `?? planLimits.*` ×4 in
`resolveEffectiveLimits`; the per-request `mergeLimits` on the read path;
`normalizeUserLimitValues`.

---

## NEXT — in order

1. **Commit this work.** It is uncommitted on `main`, and six files are untracked — a
   `git clean` would destroy them. Branch first, per the repo convention.
2. **Deploy the server code.** Safe now: every existing user has a row.
3. **Smoke-test after deploy.** Sign in, create a ride, confirm the 4th in a rolling 7 days is
   refused with `PLAN_LIMIT_EVENTS_PER_WEEK`. Then raise one user and confirm it takes effect
   with no redeploy:
   ```sql
   UPDATE user_limits SET events_per_week = 10, updated_at = NOW() WHERE user_id = 1;
   ```

## Open, deliberately not built

- **No sweeper for expired/revoked grants.** A grant with `expires_at` stops being live on its
  own, with nothing writing `user_limits`, so the user keeps elevated numbers until something
  calls `syncUserLimitsFromGrantsTx` again. Needed before timed plans are sold.
- **No revoke path** exists in `entitlements.ts`. When one is added it must call
  `syncUserLimitsFromGrantsTx`, which already writes free-tier numbers back correctly.
- **Production keeps the old null-tolerant CHECK** on `user_limits`. Functionally identical now
  that the columns are `NOT NULL`; it will just look different in a schema diff.
- **`ANONYMOUS_ENTITLEMENTS`** still uses `PLANS.free.limits`. Intentional — a signed-out caller
  has no user row, so no `user_limits` row can exist.
