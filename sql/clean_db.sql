-- Clean all tables in public schema and reset all identities.
-- Run the full file (do not run only the DECLARE...END section).
-- Usage (inside psql): \i sql/clean_db.sql
DO $clean$
DECLARE
  truncate_sql text;
BEGIN
  SELECT
    'TRUNCATE TABLE '
    || string_agg(format('%I.%I', schemaname, tablename), ', ')
    || ' RESTART IDENTITY CASCADE'
  INTO truncate_sql
  FROM pg_tables
  WHERE schemaname = 'public';

  IF truncate_sql IS NOT NULL THEN
    EXECUTE truncate_sql;
  END IF;
END;
$clean$ LANGUAGE plpgsql;
