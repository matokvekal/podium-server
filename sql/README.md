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
<<<<<<< HEAD
| `009-events-area.sql` | `events.area` free-text field | yes — additive |
| `010-drop-one-live-per-owner.sql` | drops the one-live-event-per-owner index; the "at most N" limit now lives in the server | yes — drops an index only |
=======
| `009-results.sql` | `event_participants.team` / `country_code`, finisher index | yes — additive |
| `010-event-profile.sql` | `events.activity_type` / `level` / `organizer_group`, browse index | yes — additive |
| `011-client-action-results.sql` | `client_actions.response_status` / `response_body` | yes — additive |
| `012-ride-groups.sql` | `event_groups`, `event_participants.group_id` | yes — additive |
| `013-teams-and-follows.sql` | `teams`, `team_members`, `user_follows`, `events.team_id` | yes — additive |
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
| `017-user-avatar-cover.sql` | `users.avatar_type/_value`, `cover_type/_value` | yes — additive |
| `018-user-limits.sql` | ⚠ **SUPERSEDED by sql/020 — skip.** Never applied to any database | — |
| `020-user-entitlements.sql` | `user_entitlements` — the authoritative per-user entitlement/limits model (`max_events_per_week` / `max_participants_per_event` / `max_groups_per_event`); no row = code defaults | yes — new table |
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
