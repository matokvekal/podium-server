# Bike Podium server — start here

Express 5 + TypeScript + PostgreSQL. **Live in production**, and the Android transmitter
talks to it today.

## The rule that outranks everything else

**The Android app is live and cannot be changed.** Its endpoints, its JSON field names and
the meaning of `participantId` are frozen —
[../plan/07-api-contract.md](../plan/07-api-contract.md) Part 1. A refactor that makes one
of them awkward is the wrong refactor. Everything inside the server is free to change.

Three endpoints and their exact shapes are what "live" means here:

```
GET  /api/v1/events/by-code/:code          unauthenticated, right after a QR scan
POST /api/v1/events/join                   returns participantId — the spine of tracking
POST /api/v1/events/:eventId/locations/batch   up to 200 points per request
```

## Read order

1. this file
2. [README.md](README.md) — environment variables, running, deploying
3. [sql/README.md](sql/README.md) — the schema, and which scripts to run where
4. the module you are working in: `src/modules/<name>/`

## Layout

```text
src/
  app.ts                   middleware chain and route mounting
  server.ts                process entry, graceful shutdown (pool.end)
  config/env.ts            validated environment, fails fast on bad config
  db/
    pool.ts                the pg pool, query/queryOne/execute/withTransaction
    types.ts               domain types — what Prisma used to generate
  lib/                     api-error, crypto, duration, google-auth, jwt, logger
  middleware/              requireAuth, error-handler, not-found
  modules/
    auth/    google + SMS sign-in, sessions, token rotation
    users/   profile
    events/  by-code, join, location ingest
    sms/     OTP challenge lifecycle and the SMS provider
sql/                       the hand-owned schema. Run by hand, never by a tool
tests/                     vitest, with an in-memory stand-in for the pool
```

Every module has the same five files:

```text
<name>.routes.ts       paths + middleware
<name>.controller.ts   parse, validate, call the service, respond
<name>.service.ts      business logic and permission checks
<name>.queries.ts      SQL only
<name>.schemas.ts      zod
```

## Conventions

- **No ORM.** Plain `pg` and hand-written SQL. Prisma was removed on 2026-08-13; the
  reasoning is in [../plan/11-prisma-removal.md](../plan/11-prisma-removal.md).
- **No SQL outside `*.queries.ts`.** Not in a controller, not in a service.
- **Always bind parameters** (`$1`, `$2`). SQL is never assembled from strings.
- **The database is `snake_case`, the API is `camelCase`.** Map in the query file, so
  nothing above it ever sees a column name — and the frozen responses stay byte-identical.
- **Timestamps are `TIMESTAMPTZ` and always UTC.** Every connection pins `timezone=UTC`.
  The client converts for display; the server never does.
- **Return real status codes** — 401, 403, 404, 409, 429. The reference server's "always
  200" rule is deliberately rejected: the PWA has to tell them apart, and offline replay
  depends on 409.
- **Permission checks live in the service**, not the route.

## Before saying a change is done

```bash
npm test
npm run typecheck
npm run lint
```

All three clean, no exceptions. And for anything touching auth or location ingest, the
checks that cannot be automated here — with the **real Android app**:

1. it joins an event by code
2. it transmits, and points land with the right `recorded_at`
3. airplane mode for two minutes mid-ride: on reconnect the queued points arrive with
   their **original** timestamps
4. SOS sets `emergency = true`

Check 3 is the one that catches timestamp regressions.

## What this server does not do yet

Event ownership (`events` still has no `owner_id` in the live database), per-event roles,
visibility, participant status and results, routes, live positions, history tracks. The
build order is in [../plan/01-task-list.md](../plan/01-task-list.md).

## When to update this file

When a module is added, a convention changes, or something moves off the "does not do yet"
list.
