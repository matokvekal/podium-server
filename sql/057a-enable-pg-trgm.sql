-- 057a-enable-pg-trgm.sql — OPTIONAL. Installs the pg_trgm extension (trigram matching), for a
-- later fuzzy-search index on routes.ai_search_text. Independent of 057: run it before or
-- after, or not at all — 057 does not need it.
--
-- ⚠ MAY REQUIRE ELEVATED DB PRIVILEGES
--   pg_trgm is a "trusted" extension on PostgreSQL 13+: a non-superuser with CREATE on the
--   database can install it. On PostgreSQL 12 and older it needs a superuser. If the app user
--   lacks the privilege this fails with "permission denied to create extension" — run it as a
--   superuser (e.g. postgres) instead. Nothing else is affected by that failure.
--
-- Check first:
--   SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
--   SELECT name, default_version, installed_version
--     FROM pg_available_extensions WHERE name = 'pg_trgm';
--   SELECT version();
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/057a-enable-pg-trgm.sql
--
-- SAFE ON LIVE DATA and safe to run more than once: IF NOT EXISTS is a no-op when it is
-- already installed. It only adds functions and operators; it touches no table and no data.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify afterwards:
--   SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
--   -- expect 1 row
