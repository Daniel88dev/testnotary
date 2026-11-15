-- The `testnotary` database for local development, owned by the migration role.
-- (The test world makes one database per world from a migrated template instead.)
CREATE DATABASE testnotary OWNER testnotary_migration;
REVOKE ALL ON DATABASE testnotary FROM PUBLIC;
GRANT CONNECT ON DATABASE testnotary TO testnotary_app, testnotary_retention, testnotary_migration;
