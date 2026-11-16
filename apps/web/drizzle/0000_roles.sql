-- What each role may do with every table the migration role creates from here on.
-- History tables are append-only for the app: INSERT and SELECT, never UPDATE, DELETE or TRUNCATE.
-- The retention job deletes. Only the migration role (the owner) changes the schema.
-- Expects the roles from docker/postgres/init/01-roles.sql to exist.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO testnotary_app, testnotary_retention;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE testnotary_migration IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO testnotary_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE testnotary_migration IN SCHEMA public
  GRANT SELECT, DELETE ON TABLES TO testnotary_retention;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE testnotary_migration IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO testnotary_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE testnotary_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
