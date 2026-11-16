import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

const permissionDenied = { code: "42501" };

/** A history table made the way every migration makes one: by the migration role. */
async function historyTable(name: string) {
  const migration = world.db.connect("migration");
  await migration.unsafe(`create table ${name} (id bigint generated always as identity primary key, note text not null)`);
}

describe("database roles", () => {
  test("the app role can insert into and read a history table", async () => {
    await historyTable("probe_insert");
    const app = world.db.connect("app");

    await app`insert into probe_insert (note) values ('first')`;

    expect(await app`select note from probe_insert`).toEqual([{ note: "first" }]);
  });

  test("the app role cannot update, delete or truncate a history table", async () => {
    await historyTable("probe_append_only");
    const app = world.db.connect("app");
    await app`insert into probe_append_only (note) values ('kept')`;

    await expect(app`update probe_append_only set note = 'changed'`).rejects.toMatchObject(permissionDenied);
    await expect(app`delete from probe_append_only`).rejects.toMatchObject(permissionDenied);
    await expect(app`truncate probe_append_only`).rejects.toMatchObject(permissionDenied);
    expect(await app`select note from probe_append_only`).toEqual([{ note: "kept" }]);
  });

  test("the retention role can delete history rows but not insert or update them", async () => {
    await historyTable("probe_retention");
    await world.db.connect("app")`insert into probe_retention (note) values ('old')`;
    const retention = world.db.connect("retention");

    await expect(retention`insert into probe_retention (note) values ('new')`).rejects.toMatchObject(permissionDenied);
    await expect(retention`update probe_retention set note = 'x'`).rejects.toMatchObject(permissionDenied);
    await retention`delete from probe_retention where note = 'old'`;

    expect(await retention`select note from probe_retention`).toEqual([]);
  });

  test("neither the app nor the retention role can change the schema", async () => {
    for (const role of ["app", "retention"] as const) {
      await expect(world.db.connect(role).unsafe(`create table ${role}_made (id int)`)).rejects.toMatchObject(permissionDenied);
    }
  });

  test("every table in the migrated schema is append-only for the app role", async () => {
    const tables = await world.db.connect("migration")<{ table_name: string; update: boolean; delete: boolean; truncate: boolean }[]>`
      select table_name,
             has_table_privilege('testnotary_app', format('public.%I', table_name), 'UPDATE') as update,
             has_table_privilege('testnotary_app', format('public.%I', table_name), 'DELETE') as delete,
             has_table_privilege('testnotary_app', format('public.%I', table_name), 'TRUNCATE') as truncate
      from information_schema.tables
      where table_schema = 'public' and table_name not like 'probe_%'`;

    expect(tables.filter((t) => t.update || t.delete || t.truncate)).toEqual([]);
  });

  test.each([
    { auditOneIn: 11, sandboxAuditOneIn: 5 },
    { auditOneIn: 20, sandboxAuditOneIn: 5 },
    { auditOneIn: 10, sandboxAuditOneIn: 6 },
    { auditOneIn: 0, sandboxAuditOneIn: 5 },
  ])("the database itself refuses an audit rate below the defaults: 1 in $auditOneIn, sandbox 1 in $sandboxAuditOneIn", async ({ auditOneIn, sandboxAuditOneIn }) => {
    // The service refuses these first (audit.test.ts); this is the guarantee under it.
    const app = world.db.connect("app");
    await app`insert into repos (github_id) values (${990_000 + auditOneIn * 10 + sandboxAuditOneIn}) on conflict do nothing`;

    await expect(
      app`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
          values (${990_000 + auditOneIn * 10 + sandboxAuditOneIn}, 'enforce', ${auditOneIn}, ${sandboxAuditOneIn}, null, 'test')`,
    ).rejects.toThrow(/repo_setting_changes_(sandbox_)?audit_rate/);
  });

  test("no role is a superuser, and each connects only to Testnotary's database", async () => {
    const roles = await world.db.connect("app")`
      select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles
      where rolname in ('testnotary_app', 'testnotary_retention', 'testnotary_migration') order by rolname`;
    expect(roles).toEqual([
      { rolname: "testnotary_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      { rolname: "testnotary_migration", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      { rolname: "testnotary_retention", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);

    const postgresDatabase = world.db.urls.app.replace(/\/[^/]+$/, "/postgres");
    const { default: postgres } = await import("postgres");
    const elsewhere = postgres(postgresDatabase, { max: 1, connect_timeout: 5 });
    await expect(elsewhere`select 1`).rejects.toMatchObject(permissionDenied);
    await elsewhere.end();
  });
});

describe("migrations", () => {
  const script = fileURLToPath(new URL("../scripts/migrate.ts", import.meta.url));

  function migrate(url: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
        env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: url },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
    });
  }

  test("`db:migrate` refuses to run as the app role", async () => {
    const result = await migrate(world.db.urls.app);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/migration failed: .*permission denied/);
  });

  test("`db:migrate` runs as the migration role", async () => {
    const result = await migrate(world.db.urls.migration);

    expect(result).toEqual({ code: 0, output: "migrations applied\n" });
  });
});
