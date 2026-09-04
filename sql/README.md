# SQL

The schema is hand-written and hand-run. There is no ORM and no migration tool — that is
deliberate (see [plan/11-prisma-removal.md](../../plan/11-prisma-removal.md)). Each file is
run once, in order, with `psql`.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001-init.sql
```

## Which files to run

**A fresh database**

```
001-init.sql   002-events-podium.sql   003-participants.sql
004-routes.sql 005-tracking.sql        006-client-actions.sql
008-registration-and-live.sql          009-results.sql
010-event-profile.sql                  011-client-action-results.sql
012-ride-groups.sql                    013-teams-and-follows.sql
```

007 is already included in 001 — skip it.

**The existing (Prisma-created) database**

```
900-timestamptz-migration.sql   ⚠ read it first, back up first
002-events-podium.sql
003-participants.sql
004-routes.sql
005-tracking.sql
006-client-actions.sql
007-users-avatar.sql
008-registration-and-live.sql
009-results.sql
010-event-profile.sql
011-client-action-results.sql
012-ride-groups.sql
013-teams-and-follows.sql
```

Skip 001 — those tables already exist.

**Production status (191.215.39.19/elnino), verified 2026-08-31**

`018`, `019` and the contents of `023` are APPLIED. `user_limits` holds a row per user,
all four limit columns `NOT NULL`. `020-user-entitlements.sql` is NOT applied and must not
be. Do not re-run `019`.

## The files

| File | What it does | Safe on live data |
|---|---|---|
| `001-init.sql` | the tables the server uses today, as `TIMESTAMPTZ` | fresh database only |
| `002-events-podium.sql` | `owner_id`, status, visibility, `event_members`, `location_points.event_id` | yes — additive |
| `003-participants.sql` | nullable `user_id`, start-list fields, three status axes, results | yes — additive |
| `004-routes.sql` | `routes`, `event_routes` | yes — new tables |
| `005-tracking.sql` | `participant_last_location`, `participant_tracks` | yes — new tables |
| `006-client-actions.sql` | offline de-duplication | yes — new table |
| `007-users-avatar.sql` | `users.avatar_url` | yes — additive |
| `008-registration-and-live.sql` | `requires_approval`, `is_paused`, one-live-event-per-owner index | yes — additive |
| `009-events-area.sql` | `events.area` free-text field | yes — additive |
| `009-results.sql` | `event_participants.team` / `country_code`, finisher index | yes — additive |
| `010-drop-one-live-per-owner.sql` | drops the one-live-event-per-owner index; the "at most N" limit now lives in the server | yes — drops an index only |
| `010-event-profile.sql` | `events.activity_type` / `level` / `organizer_group`, browse index | yes — additive |
| `011-client-action-results.sql` | `client_actions.response_status` / `response_body` | yes — additive |
| `012-ride-groups.sql` | `event_groups`, `event_participants.group_id` | yes — additive |
| `013-teams-and-follows.sql` | `teams`, `team_members`, `user_follows`, `events.team_id` | yes — additive |
| `014-authorization.sql` | `entitlement_grants`, `coupons`, `coupon_redemptions` | yes — new tables |
| `015-local-schema-compat.sql` | local-only catch-up. ⚠ creates `entitlement_grants` but NOT the coupon tables, which makes 014 look applied when it is not | local databases only |
| `016-schema-sync.sql` | broad convergence file; a superset of 011 and 014 | yes — additive |
| `017-user-avatar-cover.sql` | `users.avatar_type/_value`, `cover_type/_value` | yes — additive |
| `018-user-limits.sql` | `user_limits` — the single runtime source of truth for limits, every column NOT NULL. **Applied in production** | yes — new table |
| `019-user-limits-backfill.sql` | a `user_limits` row for every existing user + `SET NOT NULL`. ⚠ **REQUIRED with 018**. **Applied in production 2026-08-31** | yes — never overwrites an existing row |
| `020-user-entitlements.sql` | ⚠ **NOT ADOPTED — do not apply.** A competing `user_entitlements` model with a runtime fallback chain. Superseded by 018+019, which are live. Kept for history | — |
| `021-events-elevation-gain.sql` | `events.elevation_gain_m` — the organizer's authoritative elevation-gain value (GPX import or manual), independent of any route; reads expose `COALESCE(this, route.elevation_m)`. Every existing row is `NULL` and unchanged | yes — additive |
| `022-event-ride-plan.sql` | `events.duration_min` / `rest_stops` / `is_accessible` — organizer-set ride plan: expected time, number of rest/regroup stops, accessibility marker. Existing rows: `duration_min`/`rest_stops` `NULL`, `is_accessible` `FALSE` | yes — additive |
| `023-production-schema-gaps.sql` | the parts of 011 and 014 never applied to production (renumbered from 020 on merge) | yes — additive |
| `024-event-support-vehicle.sql` | `events.has_support_vehicle` — organizer-set flag for a sag/support vehicle following the ride. Every existing row is `FALSE` | yes — additive |
| `025-track-copy-lineage.sql` | `events.copied_from_event_id` / `copied_from_route_id` + the append-only `route_copies` ledger + `idx_event_routes_route`. Records which ride a track was copied from, and how many rides have been built on a track. Touches no existing row | yes — additive, new table starts empty |
| `026-route-copies-backfill.sql` | seeds `route_copies` from the reuse already in `event_routes`. ⚠ **writes data** — run right after 025 while the table is empty, so the undo is `DELETE FROM route_copies`. Optional; without it every track starts at 0 | yes — `ON CONFLICT DO NOTHING`, insert-only |
| `027-create-events-feature.sql` | no schema change — writes `entitlement_grants` rows for the new `create_events` feature. ⚠ **behaviour change**: with the code that ships alongside, ride creation stops being free and must be granted per account (a paid organizer plan, or a `manual` grant). Seeds the product owner; a copy-paste template grants others | yes — insert-only, `NOT EXISTS`-guarded, re-runnable |
| `028-events-expected-participants.sql` | `events.expected_participants` (nullable INT) — the organizer's turnout estimate, shown on the event page as "12 / 40" only when set. Replaces showing the plan's participant cap to viewers. Every existing row `NULL`, unchanged | yes — additive, `IF NOT EXISTS` |
| `900-timestamptz-migration.sql` | **every timestamp → `TIMESTAMPTZ`** | ⚠ **rewrites existing data** |

## Rules

- every timestamp is `TIMESTAMPTZ`, and the database stores **UTC only**
- no foreign keys — the application enforces relationships
- indexes only where a real query needs one, and each one names its query in a comment
- ⚠ in a file marks something the live Android transmitter depends on. Never rename those

## Where the live database differs

It was created by Prisma, so it uses `SERIAL` ids, PostgreSQL `ENUM` types for `role`,
`provider` and `type`, and `TEXT` for `events.id`. `001-init.sql` uses identity columns,
`VARCHAR` and `UUID` instead. The server works against either: it sends and reads plain
strings and never depends on an enum type.

Do not "fix" the live database to match. Converting an enum column in place gains nothing
and risks the same silent damage the timestamp migration is careful to avoid.
