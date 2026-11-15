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
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
