// `pnpm db:migrate`: applies the committed migrations as the migration role. The running app never
// holds this URL; it only has DATABASE_URL, the app role.
import { migrateDatabase } from "../src/db/migrate.ts";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  process.stderr.write("MIGRATION_DATABASE_URL is not set (the migration role's connection string)\n");
  process.exit(2);
}

try {
  await migrateDatabase(url);
  process.stdout.write("migrations applied\n");
} catch (error) {
  // Drizzle wraps the database's error; its cause says what Postgres refused.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  process.stderr.write(`migration failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
