# Podium PostgreSQL — the schema from sql/, baked into an image.
#
# Build context is the repo root, so the paths below are repo-relative:
#     docker build -f docker/postgres/Dockerfile -t podium-postgres .
#
# Everything in /docker-entrypoint-initdb.d runs ONCE, in alphabetical order, the first
# time the data volume is empty. That is why the files are renumbered here — the order is
# the "fresh database" order from sql/README.md.
#
# Deliberately NOT copied:
#   007-users-avatar.sql          already included in 001
#   900-timestamptz-migration.sql only for the live Prisma-created database. It rewrites
#                                 existing data and must never run unattended.

FROM postgres:17-alpine

# Matches DATABASE_URL=postgresql://podium:podium@localhost:5432/podium
ENV POSTGRES_USER=podium \
    POSTGRES_PASSWORD=podium \
    POSTGRES_DB=podium \
    TZ=UTC \
    PGTZ=UTC

# initdb args: UTF-8 everywhere, so sorting and text behave the same on every machine.
ENV POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C"

COPY sql/001-init.sql            /docker-entrypoint-initdb.d/01-init.sql
COPY sql/002-events-podium.sql   /docker-entrypoint-initdb.d/02-events-podium.sql
COPY sql/003-participants.sql    /docker-entrypoint-initdb.d/03-participants.sql
COPY sql/004-routes.sql          /docker-entrypoint-initdb.d/04-routes.sql
COPY sql/005-tracking.sql        /docker-entrypoint-initdb.d/05-tracking.sql
COPY sql/006-client-actions.sql  /docker-entrypoint-initdb.d/06-client-actions.sql

# Development seed: two example events (codes 74291 and 10001). Drop this line for a
# container you do not want test data in.
COPY sql/seed.sql                /docker-entrypoint-initdb.d/50-seed.sql

EXPOSE 5432
