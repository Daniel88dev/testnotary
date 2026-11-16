-- Creates the testnotary database and its three roles on the production instance. Run it once,
-- as the instance's master user, from a bastion session inside the VPC (never from a laptop's
-- address), with the passwords as psql variables so they never land in a file or shell history:
--
--   psql "host=<host> dbname=postgres user=<master> sslmode=verify-full sslrootcert=<rds-ca-bundle>" \
--     --set=ON_ERROR_STOP=1 \
--     --set=app_password="$(read -rs p; echo "$p")" \
--     --set=retention_password="…" --set=migration_password="…" \
--     -f infra/database/bootstrap.sql
--
-- Then put each role's connection string into its Secrets Manager entry (docs/runbook/hosting.md).
-- The migrations (apps/web/drizzle) grant the app and retention roles their table privileges.
-- Same roles and rules as docker/postgres/init/01-roles.sql, which local development uses.

\set ON_ERROR_STOP on

-- On a shared instance (`database = "shared"`), Testnotary's roles must reach no other product's
-- database. A database that grants CONNECT to PUBLIC (the default) would let them in, so the
-- bootstrap refuses to start while one does. Revoking it is that product's owner's call (for
-- flexi-day, T-802): `REVOKE CONNECT ON DATABASE <name> FROM PUBLIC;` after granting CONNECT to its
-- own roles. postgres and template1 are revoked below.
DO $$
DECLARE
  open_to_all text;
BEGIN
  SELECT string_agg(quote_ident(d.datname), ', ' ORDER BY d.datname) INTO open_to_all
  FROM pg_database d
  WHERE d.datallowconn AND d.datname NOT IN ('postgres', 'template1', 'testnotary')
    AND EXISTS (
      SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'
    );
  IF open_to_all IS NOT NULL THEN
    RAISE EXCEPTION 'these databases grant CONNECT to PUBLIC, so Testnotary''s roles could connect to them: %. Revoke it first (REVOKE CONNECT ON DATABASE <name> FROM PUBLIC), granting CONNECT to their own roles.', open_to_all;
  END IF;
END
$$;

-- None is a superuser or rds_superuser; none can create roles or databases.
CREATE ROLE testnotary_migration LOGIN PASSWORD :'migration_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE testnotary_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE testnotary_retention LOGIN PASSWORD :'retention_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- On RDS the master user may create a database owned by another role only as a member of it.
GRANT testnotary_migration TO CURRENT_USER;
CREATE DATABASE testnotary OWNER testnotary_migration;
REVOKE testnotary_migration FROM CURRENT_USER;

-- Only Testnotary's roles connect to its database. With postgres and template1 closed below and
-- every other database checked above, they connect to nothing else.
REVOKE ALL ON DATABASE testnotary FROM PUBLIC;
GRANT CONNECT ON DATABASE testnotary TO testnotary_migration, testnotary_app, testnotary_retention;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
