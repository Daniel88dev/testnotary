import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serviceConfig } from "../server/config.ts";
import * as schema from "./schema.ts";

export type Database = PostgresJsDatabase<typeof schema>;

const pools = new Map<string, { sql: postgres.Sql; db: Database }>();

/** The database for the current config, as the app role. One pool per URL. */
export function database(): Database {
  const url = serviceConfig().databaseUrl;
  if (!url) throw new Error("DATABASE_URL is not set");
  let pool = pools.get(url);
  if (!pool) {
    const sql = postgres(url, { max: 5, connect_timeout: 3, idle_timeout: 20, onnotice: () => {} });
    pool = { sql, db: drizzle(sql, { schema }) };
    pools.set(url, pool);
  }
  return pool.db;
}

/** Closes the pool for one URL, or every pool. */
export async function closeDatabase(url?: string): Promise<void> {
  const entries = url ? [...pools].filter(([key]) => key === url) : [...pools];
  for (const [key, pool] of entries) {
    pools.delete(key);
    await pool.sql.end({ timeout: 1 });
  }
}
