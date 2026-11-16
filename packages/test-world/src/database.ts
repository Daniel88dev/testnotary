import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { adminConnection, roleUrl, type PostgresServer, type Role } from "./postgres-server.ts";

export interface WorldDatabase {
  /** This world's own database, copied from the migrated template. */
  name: string;
  /** Connection strings for the three roles. The service gets `app`. */
  urls: Record<Role, string>;
  /** A short-lived connection as one role, for tests that check what a role may do. */
  connect(role: Role): postgres.Sql;
  /**
   * Every row of every table, as text: for asserting that a value (a raw token, a GitHub token)
   * is stored nowhere, whatever the schema looks like.
   */
  dump(): Promise<string>;
  drop(): Promise<void>;
}

/** Copies the template into a fresh database: a few tens of milliseconds, whatever the schema size. */
export async function createWorldDatabase(server: PostgresServer): Promise<WorldDatabase> {
  const name = `tnw_${randomBytes(6).toString("hex")}`;
  const admin = adminConnection(server);
  try {
    await admin.unsafe(`create database ${name} template ${server.templateDatabase} owner testnotary_migration`);
    await admin.unsafe(`revoke all on database ${name} from public`);
    await admin.unsafe(`grant connect on database ${name} to testnotary_app, testnotary_retention, testnotary_migration`);
  } finally {
    await admin.end({ timeout: 1 });
  }

  const opened: postgres.Sql[] = [];
  const urls = {
    app: roleUrl(server, "app", name),
    retention: roleUrl(server, "retention", name),
    migration: roleUrl(server, "migration", name),
  };
  return {
    name,
    urls,
    connect(role) {
      const sql = postgres(urls[role], { max: 1, connect_timeout: 5, onnotice: () => {} });
      opened.push(sql);
      return sql;
    },
    async dump() {
      const sql = postgres(urls.migration, { max: 1, connect_timeout: 5, onnotice: () => {} });
      try {
        const tables = await sql<{ name: string }[]>`
          select table_name as name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
        const parts: string[] = [];
        for (const { name } of tables) {
          const rows = await sql.unsafe(`select * from "${name.replace(/"/g, '""')}"`);
          parts.push(`${name}\n${JSON.stringify(rows)}`);
        }
        return parts.join("\n");
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    async drop() {
      await Promise.all(opened.map((sql) => sql.end({ timeout: 1 })));
      const sql = adminConnection(server);
      try {
        await sql.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  };
}
