# Granting access & changing limits — operator cheat-sheet

Hand-run SQL against the **production** database. Nothing here is a migration; none of it
runs automatically. Open `psql` (or DBeaver) and run the block you need.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

Two separate systems, do not confuse them:

| Question | Table | Changed by |
|---|---|---|
| **May this account create rides at all?** | `entitlement_grants` (feature `create_events`) | a grant row, or a paid plan, or the global switch (§1a) |
| **How many rides / riders / groups / teams?** | `user_limits` (4 `NOT NULL` columns) | a direct `UPDATE` |

`user_limits` is the ONLY thing the request path reads for the numbers. A plan grant does
**not** move those numbers unless it went through the app — see [§5](#5-plans).

---

## 1a. Open ride creation to EVERYONE (or close it again)  ⭐ the global switch

One flag in `app_flags` (sql/029). Flip it, no deploy, no restart — it takes effect within
~30s (a read cache), on every account including ones that sign up while it is open.

```sql
-- OPEN: every signed-in account can create rides, and the "I also organize events" switch
-- shows for everyone — exactly how it worked before the per-account gate.
UPDATE app_flags SET value = 'true',  updated_at = NOW() WHERE key = 'event_creation_open_to_all';

-- CLOSE: back to per-account. Only the blanket access goes — every individual create_events
-- grant from §1 keeps working. Accounts that got in ONLY via the open window lose creation.
UPDATE app_flags SET value = 'false', updated_at = NOW() WHERE key = 'event_creation_open_to_all';

-- check it
SELECT key, value, updated_at FROM app_flags WHERE key = 'event_creation_open_to_all';
```

Use §1 below to grant individuals (the ones who ask you) while the switch is closed.

---

## 0. Find the user

Email only exists in `auth_identities`, and only for Google / email sign-ins — an SMS-only
account has `email = NULL`. So look the person up, then work by `user_id`.

```sql
SELECT u.id AS user_id, u.first_name, u.last_name, u.nickname,
       ai.provider, ai.email, ai.phone, u.created_at
  FROM users u
  JOIN auth_identities ai ON ai.user_id = u.id
 WHERE lower(ai.email) = lower('someone@example.com')
    OR ai.phone = '+972...'
    OR lower(u.nickname) = lower('their-nickname')
 ORDER BY u.id;
```

Everyone, newest first (when you don't know what to search for):

```sql
SELECT u.id AS user_id, u.first_name, u.last_name, u.nickname,
       ai.provider, ai.email, ai.phone
  FROM users u
  JOIN auth_identities ai ON ai.user_id = u.id
 ORDER BY u.id DESC
 LIMIT 30;
```

---

## 1. Let an account create rides  ⭐ the common one

Grant the `create_events` feature. Idempotent — the `NOT EXISTS` guard makes it safe to
re-run.

**By email:**

```sql
INSERT INTO entitlement_grants (user_id, feature, source, source_ref)
SELECT DISTINCT ai.user_id, 'create_events', 'manual', 'organizer-access:WHO-OR-TICKET'
  FROM auth_identities ai
 WHERE lower(ai.email) = lower('someone@example.com')
   AND NOT EXISTS (
     SELECT 1 FROM entitlement_grants g
      WHERE g.user_id = ai.user_id AND g.feature = 'create_events' AND g.revoked_at IS NULL
   );
```

**By user_id** (SMS accounts, or when you already have the id):

```sql
INSERT INTO entitlement_grants (user_id, feature, source, source_ref)
SELECT 123, 'create_events', 'manual', 'organizer-access:WHO-OR-TICKET'
 WHERE NOT EXISTS (
   SELECT 1 FROM entitlement_grants g
    WHERE g.user_id = 123 AND g.feature = 'create_events' AND g.revoked_at IS NULL
 );
```

Takes effect on the person's **next request** — no deploy, no restart. They may need to
reopen the app so the client re-fetches `GET /users/me`.

---

## 2. Revoke ride creation

Revoke, never `DELETE` — the history of who had access matters.

```sql
UPDATE entitlement_grants
   SET revoked_at = NOW(), updated_at = NOW()
 WHERE feature = 'create_events'
   AND revoked_at IS NULL
   AND user_id = 123;
```

A revoked account keeps any rides it already made; it just cannot create new ones. The
client hides the organizer switch again on the next `GET /users/me`.

---

## 3. Change one account's limits

Direct `UPDATE` on `user_limits`. Every column is `NOT NULL`; set only the ones you want,
leave the rest. `0` is a real value ("may create none").

```sql
UPDATE user_limits
   SET events_per_week        = 20,
       participants_per_event = 300,
       groups_per_event       = 8,
       -- teams_owned          = 5,
       note       = 'raised for <who> — <ticket/reason>',
       updated_at = NOW()
 WHERE user_id = 123;
```

If somehow there is **no row** (a pre-`sql/019` account — should not happen in prod):

```sql
INSERT INTO user_limits (user_id, events_per_week, participants_per_event, groups_per_event, teams_owned, note)
VALUES (123, 20, 300, 8, 2, 'manual create — <reason>')
ON CONFLICT (user_id) DO NOTHING;
```

Signup defaults, for reference: `events_per_week 3`, `participants_per_event 50`,
`groups_per_event 2`, `teams_owned 2` (from `DEFAULT_*` env vars).

---

## 4. See what an account currently has

```sql
SELECT u.id AS user_id, ai.email, ai.phone,
       l.events_per_week, l.participants_per_event, l.groups_per_event, l.teams_owned, l.note,
       COALESCE(
         array_agg(g.feature) FILTER (WHERE g.feature IS NOT NULL AND g.revoked_at IS NULL),
         '{}'
       ) AS live_features,
       COALESCE(
         array_agg(g.plan_code) FILTER (WHERE g.plan_code IS NOT NULL AND g.revoked_at IS NULL),
         '{}'
       ) AS live_plans
  FROM users u
  JOIN auth_identities ai ON ai.user_id = u.id
  LEFT JOIN user_limits l ON l.user_id = u.id
  LEFT JOIN entitlement_grants g
         ON g.user_id = u.id
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
 WHERE u.id = 123
 GROUP BY u.id, ai.email, ai.phone,
          l.events_per_week, l.participants_per_event, l.groups_per_event, l.teams_owned, l.note;
```

`live_features` should contain `create_events` for anyone who can organize.

Every `create_events` grant on the system:

```sql
SELECT g.user_id, ai.email, ai.phone, g.source, g.source_ref, g.created_at, g.revoked_at
  FROM entitlement_grants g
  JOIN auth_identities ai ON ai.user_id = g.user_id
 WHERE g.feature = 'create_events'
 ORDER BY g.created_at;
```

---

## 5. Plans

Plan codes: `free`, `organizer_pro`, `club` (defined in `src/authz/plans.ts`).
`organizer_pro` and `club` **include `create_events`**, so granting one of them also lets the
account organize.

⚠ **A raw `INSERT` of a plan grant gives the plan's LABEL and FEATURES but NOT its limit
numbers.** The numbers only move when the grant goes through the app's `grantEntitlement()`
(which also writes `user_limits` in the same transaction). Via raw SQL you must do both:

```sql
-- the grant (features + label)
INSERT INTO entitlement_grants (user_id, plan_code, source, source_ref, expires_at)
VALUES (123, 'organizer_pro', 'manual', 'comp / beta / <ticket>', NULL);   -- expires_at NULL = forever

-- AND the numbers, by hand, to match the plan (organizer_pro shown)
UPDATE user_limits
   SET events_per_week = 30, participants_per_event = 500, groups_per_event = 10, teams_owned = 5,
       note = 'plan:organizer_pro (manual)', updated_at = NOW()
 WHERE user_id = 123;
```

`organizer_pro` limits: `30 / 500 / 10 / 5`. `club` limits: `250 / 5000 / 25 / 50`.
To end a comped plan: revoke the grant (as in §2, but `WHERE plan_code = 'organizer_pro'`)
**and** set `user_limits` back to `3 / 50 / 2 / 2`.

For most "let this person run rides" cases you do **not** need a plan — just the
`create_events` grant in §1, plus a limits bump in §3 if 3 rides/week is too few.

---

## Reference — the tables

**`entitlement_grants`** (`sql/014-authorization.sql`) — one row per "user has X from this
source". Exactly one of `plan_code` / `feature` is set. `source ∈ subscription | coupon |
purchase | trial | manual`. `revoked_at` / `expires_at` NULL = live forever.
Features: `private_events`, `create_events`, `co_organizers`, `advanced_results`.

**`user_limits`** (`sql/018-user-limits.sql`) — `events_per_week`, `participants_per_event`,
`groups_per_event`, `teams_owned`, all `NOT NULL`. One row per user, no "inherit" state.
This row **is** the answer the server enforces.
