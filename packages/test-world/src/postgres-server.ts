import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { migrateDatabase } from "@testnotary/web/migrate";
import { checkoutId, paths } from "./paths.ts";

const run = promisify(execFile);

/**
 * A running Postgres the world can create databases in, plus the migrated template each world's
 * database is copied from. Serializable, so a global setup can hand it to test workers.
 */
export interface PostgresServer {
  host: string;
  port: number;
  /** A superuser on this throwaway server. Only the harness uses it, never the service. */
  adminUser: string;
  adminPassword: string;
  /** Database with every committed migration applied, copied for each world. */
  templateDatabase: string;
}

export interface StartedPostgresServer {
  server: PostgresServer;
  stop(): Promise<void>;
}

/**
 * Starts this checkout's test Postgres in Docker Compose and prepares the template database.
 *
 * - The compose project is `tnw-<checkout hash>-<runner>`: unique per worktree, stable across runs
 *   (so a crashed run's container is reused, then removed, by the next run in the same worktree).
 * - The host port is ephemeral and read back from Docker.
 * - Set `TESTNOTARY_WORLD_POSTGRES_URL` (a superuser URL) to use an existing server instead.
 * - Set `TESTNOTARY_WORLD_KEEP=1` to leave the container running afterwards (faster reruns).
 */
export async function startPostgresServer(runner: string): Promise<StartedPostgresServer> {
  const external = process.env.TESTNOTARY_WORLD_POSTGRES_URL;
  if (external) {
    const url = new URL(external);
    const server = await prepare({
      host: url.hostname,
      port: Number(url.port || 5432),
      adminUser: decodeURIComponent(url.username),
      adminPassword: decodeURIComponent(url.password),
    });
    return { server, stop: async () => {} };
  }

  const project = `tnw-${checkoutId}-${runner}`;
  const compose = (...args: string[]) =>
    run("docker", ["compose", "-f", paths.composeFile, "-p", project, ...args], { maxBuffer: 1 << 24 });

  try {
    await compose("up", "--detach", "--wait", "--quiet-pull");
  } catch (error) {
    throw new Error(
      `The test world could not start Postgres in Docker (compose project ${project}). Is Docker running?\n${describe(error)}`,
      { cause: error },
    );
  }
  const { stdout } = await compose("port", "postgres", "5432");
  const port = Number(stdout.trim().split(":").pop());
  const stop = async () => {
    if (process.env.TESTNOTARY_WORLD_KEEP === "1") return;
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "2");
  };
  try {
    const server = await prepare({ host: "127.0.0.1", port, adminUser: "postgres", adminPassword: "postgres" });
    return { server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function prepare(admin: Omit<PostgresServer, "templateDatabase">): Promise<PostgresServer> {
  const templateDatabase = `tnw_template_${await migrationsHash()}`;
  const sql = adminConnection(admin);
  try {
    // Serialize role and template creation across runners that share an external server.
    await sql`select pg_advisory_lock(8070807)`;
    await sql.unsafe(await readFile(paths.rolesSql, "utf8"));
    const [existing] = await sql`select 1 from pg_database where datname = ${templateDatabase}`;
    if (!existing) await createTemplate(admin, templateDatabase);
    await sql`select pg_advisory_unlock(8070807)`;
  } finally {
    await sql.end({ timeout: 1 });
  }
  return { ...admin, templateDatabase };
}

async function createTemplate(admin: Omit<PostgresServer, "templateDatabase">, name: string): Promise<void> {
  const building = `${name}_building`;
  const sql = adminConnection(admin);
  try {
    await sql.unsafe(`drop database if exists ${building} with (force)`);
    await sql.unsafe(`create database ${building} owner testnotary_migration`);
    await sql.unsafe(`revoke all on database ${building} from public`);
    await sql.unsafe(`grant connect on database ${building} to testnotary_migration`);
    await migrateDatabase(roleUrl(admin, "migration", building));
    // Rename only once fully migrated, so a crash never leaves a half-built template behind.
    await sql.unsafe(`alter database ${building} rename to ${name}`);
    await sql.unsafe(`alter database ${name} with is_template true allow_connections false`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function migrationsHash(): Promise<string> {
  const hash = createHash("sha256");
  const files = (await readdir(paths.migrations, { recursive: true })).sort();
  for (const file of files) {
    if (!file.endsWith(".sql") && !file.endsWith(".json")) continue;
    hash.update(file).update(await readFile(`${paths.migrations}/${file}`));
  }
  hash.update(await readFile(paths.rolesSql));
  return hash.digest("hex").slice(0, 12);
}

export type Role = "app" | "retention" | "migration";

/** Connection string for one of the three roles (their passwords are the local development ones). */
export function roleUrl(server: Pick<PostgresServer, "host" | "port">, role: Role, database: string): string {
  const user = `testnotary_${role}`;
  return `postgres://${user}:${user}@${server.host}:${server.port}/${database}`;
}

export function adminConnection(server: Omit<PostgresServer, "templateDatabase">, database = "postgres") {
  return postgres({
    host: server.host,
    port: server.port,
    user: server.adminUser,
    password: server.adminPassword,
    database,
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) return String(error.stderr);
  return error instanceof Error ? error.message : String(error);
}
