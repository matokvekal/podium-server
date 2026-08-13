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
