import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies the committed migrations. Pass the migration role's URL; no other role can. */
export async function migrateDatabase(migrationDatabaseUrl: string): Promise<void> {
  const sql = postgres(migrationDatabaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
