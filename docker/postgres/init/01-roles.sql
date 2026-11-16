-- The three Testnotary roles. None is a superuser, and none can create roles or databases.
--   testnotary_app        INSERT and SELECT on history tables (granted by the migrations)
--   testnotary_retention  SELECT and DELETE, for the scheduled retention job only
--   testnotary_migration  owns the database and runs DDL; the running app never holds it
-- Idempotent: the test world runs this file against its own Postgres too.
-- The passwords are local development values; hosted environments set their own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'testnotary_migration') THEN
    CREATE ROLE testnotary_migration LOGIN PASSWORD 'testnotary_migration'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'testnotary_app') THEN
    CREATE ROLE testnotary_app LOGIN PASSWORD 'testnotary_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'testnotary_retention') THEN
    CREATE ROLE testnotary_retention LOGIN PASSWORD 'testnotary_retention'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- The roles may connect only to Testnotary's own database.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
