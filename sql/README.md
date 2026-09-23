# SQL

The schema is hand-written and hand-run. There is no ORM and no migration tool — that is
deliberate (see [gilad/reference/prisma-removal.md](../../gilad/reference/prisma-removal.md)). Each file is
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
| `029-app-flags.sql` | `app_flags` key/value table for operator-flipped global switches. Seeds `event_creation_open_to_all` (`'false'`) — flip to `'true'` to open ride creation to every account, no deploy. Read by `src/authz/entitlements.ts` (30s cache) | yes — new table, `DO NOTHING` seed |
| `030-country.sql` | `users.country` + `events.country` (`CHAR(2)`, nullable). Backfills every existing ride to `'IL'` (Israel-only today); `users.country` left `NULL` for the client to fill from locale. Partial index on public `events(country)`. Powers the "Browse tracks" country filter | yes — additive, `IF NOT EXISTS`; the one `UPDATE` only touches `country IS NULL` |
| `031-analytics-events.sql` | `analytics_events` — append-only server-side log of business actions (created/joined/route created/copied…) + indexes + the `analytics_daily_summary` VIEW. Written non-fatally by `src/audit/audit.service.ts`; never read on the request path. No client change | yes — new table + view, nothing existing touched |
| `032-events-region.sql` | `events.region` — the column 030 was supposed to add and never did, which was making `selectPublicEvents` throw and silently fall back to an unfiltered legacy query in production. Restores the country/area/distance/climb/duration/surface filters | yes — additive, `IF NOT EXISTS` |
| `033-user-limits-concurrent-live-events.sql` | `user_limits.concurrent_live_events` — the real per-user cap on simultaneous live rides. `changeEventStatus` had always hard-refused a 2nd live event regardless of `MAX_CONCURRENT_LIVE_EVENTS_FREE`, which was never wired up; this makes the limit real and per-account. Every existing row defaults to `1`, i.e. today's behaviour, unchanged until explicitly raised | yes — additive, `IF NOT EXISTS`, `DEFAULT 1` |
| `034-users-weight.sql` | `users.weight_kg` — the rider's body weight, for Rider Statistics' personal calorie estimate. Nullable, no default; `NULL` means "never set", never a guessed number | yes — additive, `IF NOT EXISTS` |
| `035-rider-stats-cache.sql` | `rider_stats_cache` — a per-rider, per-scope (lifetime/year) cache of computed ride totals for `src/statistics/`, including a denormalized snapshot of the rider's country for the National Leaderboard's partition. A cache, not a source of truth — every row can be rebuilt from `event_participants`/`events`/`participant_tracks` with no data loss | yes — new table, starts empty |
| `036-route-likes.sql` | `route_likes` (append-only, one row per track+rider) and `route_favorites` (toggle) — the public like count and a rider's private bookmarks for Find Tracks | yes — new tables |
| `037-event-link-groups.sql` | `events.link_group_id` (UUID) — 2–3 same-day rides shared through ONE link (`/share/<codeA>-<codeB>`); rides stay separate | yes — additive, nullable |
| `038-event-terrain-grade.sql` | `events.terrain_grade` (SMALLINT 1..5, NULL = not stated) — how technical the ground is; orthogonal to `level` | yes — additive, nullable |
| `039-rider-period-stats.sql` | `rider_period_stats` — a per-rider, per-month and per-year cache of computed ride totals for the Statistics timeline (Achievements page), plus seeds the `stats_require_live_checkin` flag in `app_flags` (`false` = every registered/approved rider counts a finished ride; `true` = only riders marked present/started). A cache, not a source of truth — every row can be rebuilt. Needs `029-app-flags.sql` for the flag row | yes — new table + one `ON CONFLICT DO NOTHING` insert, starts empty |
| `040-auto-check-in.sql` | `events.auto_check_in` (`BOOLEAN NOT NULL DEFAULT TRUE`) — the organizer's switch for automatic arrival — and `event_participants.attendance_source` (`manual` / `auto` / `NULL`) — how a rider came to be marked arrived, so the app can show automatic arrivals differently. Existing rides backfill to `TRUE` (harmless: the check only acts inside a window around the ride's own start); every existing attendance row is `NULL`, i.e. reads as manual | yes — additive, `IF NOT EXISTS` |
| `041-event-trail-metadata.sql` | `events.route_difficulty` (easy / moderate / hard / challenging), `events.season` and `events.shade` — nullable descriptive fields for mtb / gravel tracks, filled by the curated MTB import and the ride form. Orthogonal to `level` and `terrain_grade`, which are unchanged. NULL on every existing ride | yes — additive, nullable, `IF NOT EXISTS` |
| `044-stats-history-backfill.sql` | `users.stats_backfill_excluded` (`BOOLEAN NOT NULL DEFAULT FALSE`) — accounts the Statistics history backfill (`npm run stats:backfill`) skips — and the `stats_live_checkin_from` app flag that makes the check-in requirement apply only to rides from that instant on. Existing rows: every user `FALSE`, flag empty (= requirement not applied) | yes — additive |
| `042-route-original-gpx.sql` | `route_gpx_files` — the ORIGINAL GPX of a track, byte for byte (BYTEA + sha256 + length + file name), read only by `GET /routes/:routeId/gpx`. Until now the app never kept the source file and rebuilt every download from the stored points. A separate table so the multi-megabyte content never rides along on `routes` reads. No route has one until it is imported; the client falls back to the rebuilt GPX | yes — new table, starts empty |
| `043-route-imported-counts.sql` | `routes.imported_download_count` / `routes.imported_like_count` (`INTEGER NOT NULL DEFAULT 0`) — an imported starting popularity, ADDED to the real `route_copies` / `route_likes` row counts at read time. Real likes and downloads are untouched, and no fake users or rows are created. Every existing route reads 0 | yes — additive, `DEFAULT 0` |
| `045-rider-stats-cache-columns.sql` | `rider_stats_cache.country` (`CHAR(2)`, nullable) and `rider_stats_cache.total_hours` (`DOUBLE PRECISION NOT NULL DEFAULT 0`) — brings a cache table created from an EARLIER draft of `035` up to the shape `035` describes and `src/statistics/` writes (production was in that state: 035 is a no-op there because the table already existed). ⚠ already applied on prod — never re-run. A cache, rebuildable from the raw tables | yes — additive, `IF NOT EXISTS`, metadata-only |
| `046-route-thumb.sql` | `routes.thumb_points` (JSONB, nullable) — 60-point card preview embedded in list responses; backfill with `npm run routes:thumbs` | yes — additive, nullable |
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
