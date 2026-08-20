# Authorization architecture — identity, roles, entitlements, visibility

**Status:** design + implementation, 2026-08-20. The server is the authority; the client
renders what the server says it may.

> **Path convention:** paths are relative to the workspace root (`C:\dev2026\podiom`).

---

## The one rule

**Nothing outside `src/authz/` may ask "is this user premium".**

Endpoints ask for a **capability**. The policy answers. Where that capability came from — a
free plan, a subscription, a beta coupon, a one-time purchase, a role on this one event — is
the policy's problem and nobody else's. That is what makes it possible to add tiers, coupons,
trials and one-time purchases later without touching a single route.

The same rule in the negative: **no price, no product name and no billing concept appears in
authorization code.** Plans carry *limits and features*. What a plan costs, how it is sold and
who is invoiced belong to a billing module that does not exist yet and, when it does, will
write `entitlement_grants` rows and nothing else.

---

## Five independent layers

```
1. Identity          who you are            users, auth_identities        (or nobody: guest)
        │
2. Global role       what you are app-wide  users.role
        │
3. Event role        what you are HERE      event_members.role + event_participants
        │
4. Entitlements      what you have paid     entitlement_grants → plan + features + limits
   or been granted   for or been given
        │
5. Visibility        what the ride reveals  events.visibility + the six show_* flags
        ↓
   capability(actor, action, resource) → boolean
```

Each layer is resolved separately and none of them knows about the others. A user can be a
guest (1) with no role (2), an owner of one event (3) on a free plan (4) looking at someone
else's private ride (5) — and each of those five facts is fetched by its own function.

### Why the layers must stay separate

The temptation is to collapse 2 and 4 — to make "premium" a role. That breaks the moment a
coupon grants Pro until a date, because a role has no expiry, no source and no scope. It
breaks again when someone buys **one** private event, because that is not a role at all.

Equally, 3 must not collapse into 2. *"A user who created an event gets admin permissions for
that event only, not globally."* An event owner is not an app admin, and the model must make it
impossible to confuse the two — which it does, because event roles are rows in
`event_members` keyed by `(event_id, user_id)` and can never be read without an event in hand.

---

## Layer 1 — Identity

`users` + `auth_identities`, unchanged. The only thing worth stating: **absence of identity is
a first-class case.** A guest is not an error, a null, or a degraded user — they are the
default audience for the app's front door (public rides and the track library). The policy
takes `userId: number | null` everywhere.

## Layer 2 — Global role

`users.role`, unchanged: `RIDER | COMMISSAIRE`. Plus a derived `guest` when there is no
identity. That is the whole of it, and it should stay that way — every temptation to add a
role here ("premium", "organizer") belongs in layer 3 or 4.

| Global role | Who | Notes |
|---|---|---|
| `guest` | nobody signed in | derived, never stored |
| `RIDER` | every account | the default; "Viewer" and "Rider" from the pricing table are both this |
| `COMMISSAIRE` | staff | pre-existing; not used for entitlements |

**"Organizer" is not a role.** Creating rides is a capability every registered user has, within
the limits their plan gives them. The pricing table's "Organizer Free" and "Organizer Pro" are
the same *role* on different *plans* — layer 4.

## Layer 3 — Event role

Two separate relations, deliberately not merged:

| Relation | Table | Values |
|---|---|---|
| **role** — what you may *do* here | `event_members.role` | `owner`, `operator`, `viewer` |
| **participation** — whether you are *riding* | `event_participants.registration_status` | `registered`, `waiting_approval`, `approved`, `rejected` |

A person who both organizes and rides has a row in both. `event_members` has existed since
`sql/002` and was read by nothing until now; the owner row is written at event creation and
backfilled for every existing event by `sql/014`.

`operator` is the co-organizer slot the "Club / Business" tier sells ("multiple admins"). The
policy already honours it, so enabling it later is an entitlement change, not a code change.

## Layer 4 — Entitlements

The extensible layer, and the one the request is really about.

### Plans are definitions; grants are facts

**Plan definitions** live in `src/authz/plans.ts` — code, not the database, because limits and
features are decisions that belong in review and in git history. They carry **no price**.

**Grants** live in `entitlement_grants` — one row per "this user has X, from this source,
during this window". A grant confers *either* a whole plan or a single feature.

```
entitlement_grants
  user_id
  plan_code      'organizer_pro'   ─┐ exactly one of these
  feature        'private_events'  ─┘
  quantity / consumed               consumable grants (a one-time purchase)
  scope_type / scope_id             NULL = account-wide; 'event' = this ride only
  source         subscription | coupon | purchase | trial | manual
  source_ref     stripe id, coupon code, support ticket
  starts_at / expires_at            NULL expiry = forever
  revoked_at                        refunds and support, without deleting history
```

Every product in the pricing table is one shape of grant:

| Product | Becomes |
|---|---|
| Organizer Pro subscription | `plan_code='organizer_pro'`, `source='subscription'`, `expires_at` = period end |
| **Beta coupon** | `plan_code='organizer_pro'`, `source='coupon'`, `expires_at` = the date on the coupon |
| Private Event (one-time) | `feature='private_events'`, `quantity=1`, `source='purchase'` — consumed when the ride is created |
| Club / Business | `plan_code='club'` — the plan is already defined, just not sold |
| Support / goodwill | `source='manual'` with a `source_ref` naming the ticket |

Adding a tier is a `plans.ts` entry. Adding a *way of selling* it is a row writer. Neither
touches the policy.

### Resolution

`resolveEntitlements(userId)` reads every live grant (started, not expired, not revoked, not
fully consumed) and folds them:

- **plan** — the highest-`rank` plan among active plan grants; `free` if none
- **features** — the union of the winning plan's features and every active feature grant
- **limits** — the **most generous** value per limit across all active plans

Most-generous rather than last-wins matters: a beta coupon must never *reduce* what a paying
subscriber already has, and two overlapping grants must not depend on row order.

### Coupons

`coupons` + `coupon_redemptions`. A coupon says what it grants and for how long
(`grant_days` from redemption, or a fixed `grant_until`), how many times it may be redeemed in
total, and when it stops working. Redemption is one per user per coupon, enforced by the
primary key rather than by a check.

This exists now specifically because of the beta plan: *"we will use many free Premium coupons
with expiration dates."* Handing out Pro for 90 days is inserting one coupon row.

## Layer 5 — Visibility

Separate from roles, as required. `events.visibility`:

| Value | Who can see the ride exists |
|---|---|
| `public` | everyone, including guests |
| `registered` | any signed-in user — **new** |
| `private` | only people with a participation row or an event role; everyone else gets 404 |

Orthogonal to that, the six `show_*` flags say *how much* a permitted viewer sees
(participants, route, live positions, history, results, and the time/place details).

Visibility answers "does this ride exist for you". The flags answer "how much of it".

---

## Capabilities — the contract with the client

The client must not re-derive any of the above. The server computes and sends a **capability
list**; the client renders from it.

```
GET /users/me        → account capabilities, plan, limits, usage
GET /events/:id      → capabilities[] for this event, for this caller
```

### Account capabilities

`event:create`, `event:create_private`, `team:create`, `route:create`, `route:publish`

### Event capabilities

`event:view`, `event:view_details`, `event:view_route`, `event:view_participants`,
`event:view_live`, `event:view_results`, `event:view_history`, `event:join`, `event:edit`,
`event:change_status`, `event:delete`, `event:manage_participants`, `event:manage_groups`,
`event:manage_route`, `event:manage_members`

### Why capabilities and not roles on the wire

If the server sent `role: "owner"` and `plan: "pro"`, the client would have to reimplement the
rules to decide what to show — and would drift. Sending the *answers* means the client has one
job: hide what is not in the list. When a rule changes, only the server changes.

`GET /users/me` also returns the resolved plan, its limits and current usage, so a client can
say *"3 of 3 rides used this week"* and prompt an upgrade without knowing what a plan is.

### Refusals are typed

- **401** not signed in
- **403** signed in, not permitted — a role/visibility answer
- **404** private resource, no relationship — never confirm it exists
- **409 + `PLAN_LIMIT_*`** permitted, but out of allowance → the client shows *upgrade*
- **402 + `PLAN_FEATURE_*`** permitted, but the feature is not in this plan → the client shows
  *buy this*

402 and 409 are deliberately different: "you have hit your ceiling" and "this is not part of
your plan" lead to different screens and different purchases.

---

## Module layout

```text
src/authz/
  capabilities.ts   the catalogue — the contract with the client
  plans.ts          plan definitions: limits + features, NEVER prices
  entitlements.ts   grants → { plan, features, limits }; the only reader of grants
  actor.ts          identity + global role + entitlements, resolved once per request
  event-context.ts  event role + participation for one event
  policy.ts         pure can(actor, capability, context) — no I/O, no database
```

`policy.ts` is deliberately pure and dependency-free: every authorization decision in the
product is one function, testable without a database, and readable in one sitting.

---

## What this replaces

- `ViewerTier` and the ad-hoc `canViewEventInfo` / `canViewRoute` / `canViewResults` /
  `canViewHistory` helpers scattered across three services — now one policy.
- `lib/plan-limits.ts`'s hard-coded `FREE_PLAN` constant — now a plan definition resolved
  through entitlements.
- The client's `isOwner` + `viewerTier` + six `show_*` booleans, which it had to interpret
  itself — now a capability list.

## What is deliberately still missing

- **Billing.** No payment provider, no invoices, no subscription lifecycle. Grants are written
  by hand or by coupon today. That is the seam a billing module plugs into.
- **Prices.** Not in this codebase at all, by design. The pricing table lives in the product
  documentation; the server knows only what each plan *allows*.
- **`operator` in the UI.** The policy honours co-organizers; nothing writes an operator row
  yet, because that is the Club tier and it is not being sold.
