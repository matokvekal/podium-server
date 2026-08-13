# Commissaire Server

Backend API for the Bike Podium web app and the Transmiter Android app. TypeScript, Express 5,
PostgreSQL through the `pg` driver with hand-written SQL, Google + SMS sign-in. Planning documents
live in [`../plan`](../plan); start with [`../AGENT.md`](../AGENT.md). This README only covers
day-to-day dev commands.

**Architecture in one sentence:** Google and SMS are identity *providers* that only answer "who is
this person" — after a successful provider check, the server issues its own short-lived
Commissaire access token + rotating refresh token, and every other route only ever accepts that
token, never a Google ID token or an OTP code.

## Requirements

- Node.js 24+
- PostgreSQL (only needed once you start hitting `/api/v1/auth/*` — `/health` and
  `/api/v1/auth/config` work without it). Easiest route is the Docker container below —
  it comes with the schema already applied.
- Docker, if you use that container

## Setup

```bash
npm install
cp .env.example .env    # fill in real values, never commit .env
docker compose up -d db # local Postgres, schema included — see below
```

`.env.example` already points `DATABASE_URL` at that container, so with Docker there is
nothing to fill in for the database. Still to do by hand: the Google OAuth client
(`GOOGLE_CLIENT_IDS`). For any database that is *not* the container, run the scripts in
[`sql/`](./sql) yourself — see [`sql/README.md`](./sql/README.md) for which files apply to a
fresh database and which to the existing one.

## Database in Docker

`docker-compose.yml` + [`docker/postgres/Dockerfile`](./docker/postgres/Dockerfile) build a
PostgreSQL 17 image with the fresh-database scripts from `sql/` baked in. First start
creates the schema; later starts just reuse the volume. Identical on Windows and Linux.

```bash
docker compose up -d db     # start (first run builds and applies the schema)
docker compose logs -f db   # watch it apply sql/
docker compose ps           # "healthy" means the schema is in and it accepts connections
docker compose down         # stop, keep the data
docker compose down -v      # stop and DELETE the data — next `up` re-runs sql/ from scratch
```

| | |
|---|---|
| user / password / database | `podium` / `podium` / `podium` |
| host port | `5432` |
| connection string | `postgresql://podium:podium@localhost:5432/podium` |
| data | named volume `podium-db-data`, survives `down` but not `down -v` |
| timezone | `UTC`, matching the server's rule that the database stores UTC only |

The credentials are deliberately trivial: this container is for local development and its
port is published to `localhost` only. Never point it at anything real.

Applied on first start, in this order — the "fresh database" list from
[`sql/README.md`](./sql/README.md):

```
001-init  002-events-podium  003-participants  004-routes  005-tracking  006-client-actions
```

then `seed.sql`, which inserts two development events (codes `74291` and `10001`). Two files
are deliberately **not** in the image: `007-users-avatar.sql` (already part of 001) and
`900-timestamptz-migration.sql` (only for the live Prisma-created database — it rewrites
existing data and must never run unattended).

A psql shell inside the container:

```bash
docker exec -it podium-db psql -U podium -d podium
```

**Adding a schema file.** Write it in `sql/` as usual, add a `COPY` line to
`docker/postgres/Dockerfile`, then rebuild against an empty volume:
`docker compose down -v && docker compose up -d --build db`. Init scripts only ever run on an
empty data directory, so a rebuild alone changes nothing on an existing volume. Applying a
new file to a container you want to keep is the same hand-run `psql` as any other database:

```bash
docker exec -i podium-db psql -U podium -d podium -v ON_ERROR_STOP=1 < sql/00X-whatever.sql
```

**Port 5432 already in use** (a Postgres installed on the machine): change the host side of
the mapping in `docker-compose.yml` to `"5433:5432"` and put `5433` in `DATABASE_URL`.

### On Linux at home

Same two commands, no changes:

```bash
git clone <repo> && cd podium-server
cp .env.example .env
docker compose up -d db
npm install && npm run dev
```

Docker Engine + the Compose plugin need to be installed (`docker.io` and
`docker-compose-plugin`, or Docker's own apt repository). Either add your user to the
`docker` group or prefix the commands with `sudo`. `localhost:5432` behaves the same as it
does on Docker Desktop.

### Environment variables

| Variable                | Required        | Notes                                                                 |
| ------------------------ | ---------------- | ------------------------------------------------------------------------ |
| `PORT`                   | no               | `.env.example` sets `6500`. The built-in fallback if the variable is absent entirely is still `5000` (`src/config/env.ts`). |
| `DATABASE_URL`           | no*              | Postgres connection string. *Required for any `/api/v1/auth/*` or `/api/v1/users/*` route to work. Defaults in `.env.example` to the Docker container: `postgresql://podium:podium@localhost:5432/podium`. |
| `JWT_ACCESS_SECRET`      | yes in production | Min 32 chars. Insecure dev default used automatically outside production. Signs the access token only — refresh tokens are opaque random values, not JWTs, so there's no `JWT_REFRESH_SECRET`. |
| `JWT_ACCESS_EXPIRES_IN`  | no               | Defaults to `15m`.                                                       |
| `JWT_REFRESH_EXPIRES_IN` | no               | Defaults to `30d`. Controls session lifetime (`sessions.expires_at`).    |
| `GOOGLE_CLIENT_IDS`      | yes (if GOOGLE enabled) | Comma-separated OAuth client IDs accepted as token audience. See SETUP.md. |
| `SMS_PROVIDER`           | no               | `MOCK` (default, logs codes locally) or `TWILIO` (not implemented yet).  |
| `AUTH_PROVIDERS`         | no               | Comma-separated, defaults to `GOOGLE`. Controls both `GET /auth/config` and which providers' endpoints accept requests. |
| `CORS_ORIGINS`           | yes              | Comma-separated allowed browser origins for the web dashboard.           |
| `LOG_LEVEL`              | no               | Pino level, defaults to `info`.                                          |

Startup fails fast (`process.exit(1)`) on invalid config: unknown `AUTH_PROVIDERS` values, or
missing/short `JWT_*_SECRET` in production.

## Running

```bash
npm run dev:all   # database + hot-reloading server — the one to use day to day
npm run dev       # tsx watch only, assumes the database is already up
npm start         # build, then run dist/server.js
npm run build     # tsc -> dist/ only
npm run serve     # run dist/server.js without rebuilding (what a process manager should run)
```

`npm start` builds first on purpose: running it on a fresh clone used to fail with
`Cannot find module dist/server.js` because nothing had produced `dist/` yet. It does **not**
start Docker — production has no Docker and a real `DATABASE_URL` — so on a machine using the
container, either use `npm run dev:all` or bring the database up yourself with `npm run db:up`.

Database-only helpers, all thin wrappers over the compose file:

```bash
npm run db:up     # start and wait until healthy (schema applied)
npm run db:down   # stop, keep the data
npm run db:reset  # DELETE the data and rebuild the schema from sql/
npm run db:logs   # follow the container log
npm run db:psql   # psql shell inside the container
```

`GET /health` returns `{ "status": "ok" }` and never touches the database. A quick check that
the server really reached the container — the code comes from `sql/seed.sql`:

```bash
curl http://localhost:6500/api/v1/events/by-code/74291
```

## Database

**No ORM.** Plain `pg` with hand-written SQL, and the schema is owned by hand in
[`sql/`](./sql) — run with `psql`, never by a migration tool. Prisma was removed on
2026-08-13; the reasoning is in [`../plan/11-prisma-removal.md`](../plan/11-prisma-removal.md).
For local work, [Database in Docker](#database-in-docker) applies those same files for you on
the container's first start; it is a convenience, not a migration tool.

The layout inside `src`:

- `db/pool.ts` — the shared pool, plus `query` / `queryOne` / `execute` / `withTransaction`
- `db/types.ts` — the domain types that used to be generated (`User`, `Session`, `Event`, …)
- `modules/<name>/<name>.queries.ts` — **the only place SQL is allowed**. Controllers and
  services never contain a statement

Every value is bound (`$1`, `$2`); SQL is never assembled from strings. The database is
`snake_case` and the API is `camelCase`, and the mapping happens in the query file, so
nothing above it ever sees a column name.

Every timestamp column is `TIMESTAMPTZ` and the database stores **UTC only**. Each connection
pins `timezone=UTC`. Clients convert to the viewer's local time; the server never does.

## Auth flow

Google/SMS only establish identity; they are never accepted by any other route.

1. `GET /api/v1/auth/config` — public. Returns `{ "providers": ["GOOGLE", "SMS"] }` (whatever's
   enabled via `AUTH_PROVIDERS`). Clients call this before rendering the login screen and only
   show the returned methods.
2. `POST /api/v1/auth/google` — body `{ "idToken": "<google-id-token>" }`. Verifies the token once,
   finds-or-creates the user, returns `{ user, accessToken, refreshToken, requiresProfile }`.
3. `POST /api/v1/auth/sms/request` — body `{ "phone": "+15551234567" }` (E.164). Returns
   `{ challengeId }`; the code itself is only ever sent via the configured `SmsProvider`, never in
   the response.
4. `POST /api/v1/auth/sms/verify` — body `{ "challengeId", "code" }`. Same response shape as
   `/google` on success.
5. Every other route requires `Authorization: Bearer <accessToken>` (the Commissaire token from
   step 2/4, not a Google ID token). `requireAuth` middleware verifies it statelessly (signature +
   expiry only, no DB/network call) and sets `req.auth = { userId, role, sessionId }`.
6. `POST /api/v1/auth/refresh` — body `{ "refreshToken" }`. The refresh token is an opaque random
   value; the server only ever stores `sha256(refreshToken)` in `sessions.refresh_token_hash` and
   looks sessions up by that hash. A successful refresh rotates it in place (new token issued, old
   hash overwritten, so reusing an already-rotated token no longer matches any session and is
   rejected). Returns a fresh `{ accessToken, refreshToken }`.
7. `POST /api/v1/auth/logout` — requires an access token; revokes that session. The access token
   itself stays valid until its own short natural expiry (stateless verification tradeoff), but no
   further refresh is possible once revoked.
8. `POST /api/v1/auth/logout-all` — requires an access token; revokes every session belonging to
   that user (all devices).
9. `PATCH /api/v1/users/me` — requires an access token. Body: any of `firstName`, `lastName`,
   `nickname`, `emergencyPhone` (all optional; `emergencyPhone` is never required for
   `requiresProfile` to resolve `false` — the other three are).
10. A provider disabled via `AUTH_PROVIDERS` rejects its endpoints with
   `403 { "error": "AUTH_PROVIDER_DISABLED" }` rather than 404 — the implementation stays in place,
   only exposure/acceptance is toggled.

New users always get `role: "RIDER"`; there's no client-controlled path to `COMMISSAIRE` — promote
a user by editing the database directly until a real admin flow exists. A disabled account
(`users.is_active = false`) is rejected at sign-in and at refresh time.

## Testing and quality

```bash
npm test         # vitest — Google/SMS calls and the database are faked, no network/DB needed
npm run typecheck
npm run lint
```

Tests cover: Google sign-in (new user, duplicate identity, invalid token, unverified email),
SMS OTP (happy path, wrong code, attempt lockout, expiry, resend cooldown), refresh rotation and
reuse rejection, deactivated-user refresh, multi-session isolation, logout and logout-all
revocation, tampered/expired tokens, the `AUTH_PROVIDERS` enable/disable behavior, profile
completion, and the three frozen transmitter endpoints (event lookup by code, idempotent join,
location batch ingest with `recordedAt` preserved).

`tests/support/fake-db.ts` stands in for `src/db/pool.ts`. It dispatches on the SQL text the
query files actually send and stores `snake_case` rows, so a renamed column or a broken
statement fails there rather than passing quietly. Only the database is faked — hashing,
expiry, rotation and revocation all run for real.

## Deploying

CI (`.github/workflows/node.js.yml`) runs on a self-hosted runner on push to `staging`: installs
deps, builds, and restarts the process under PM2 as `api`. **The Prisma generate step must be
removed from that workflow** — there is no Prisma client to generate any more. Schema changes are
never applied by CI: the scripts in `sql/` are run by hand.

Manual access to the box:

```bash
ssh -i "C:\ssh\koali-key-24.pem" ubuntu@ec2-18-199-57-38.eu-central-1.compute.amazonaws.com
```

The runtime `.env` lives at `/home/ubuntu/env/.env` on the host; CI symlinks it into the project
directory on each deploy. Reverse proxy is nginx with Let's Encrypt (see DigitalOcean's Ubuntu
nginx/Let's Encrypt guide for the general steps used originally).

## What changed from the old backend

This replaces the legacy Kids/Parents product (MySQL/Sequelize, MongoDB, Socket.IO, local JWT, SMS
OTP with a hardcoded bypass code). That code is preserved at the git tag `legacy-koali-backup` if
anything needs to be recovered. `serviceAccountKey.json`, which was previously committed, is no
longer used at all — auth verifies Google ID tokens directly instead of going through Firebase
Admin. **That credential should still be rotated/revoked in Google Cloud Console**, since it was
exposed in git history.
