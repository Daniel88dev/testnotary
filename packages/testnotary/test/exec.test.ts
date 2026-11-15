import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

/** A suite whose command is `node -e <script>`: the script stands in for a test runner. */
function nodeSuite(script: string) {
  return { command: ["node", "-e", script] };
}

function lastLine(text: string): string {
  return text.trimEnd().split("\n").at(-1) ?? "";
}

describe("testnotary exec", () => {
  test("a passing suite exits 0 and ends with the summary line", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: nodeSuite("console.log('tests ok')") } } });
    const commit = await repo.revParse("HEAD");
    const tree = await repo.tree();

    const result = await world.runCli(["exec", "unit"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tests ok\n");
    expect(lastLine(result.stderr)).toBe(`outcome=passed suite=unit attested=false tree=${tree} commit=${commit} url=`);
  });

  test("a failing suite exits 1, and --json carries the real exit code with the child's stdout moved to stderr", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: nodeSuite("console.log('3 tests failed'); process.exit(3)") } } });
    const commit = await repo.revParse("HEAD");
    const tree = await repo.tree();

    const result = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("3 tests failed\n");
    expect(lastLine(result.stderr)).toBe(`outcome=failed suite=unit attested=false tree=${tree} commit=${commit} url=`);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(
      ["outcome", "refusal", "exitCode", "attested", "attestationUrl", "tree", "commit", "durationMs", "warnings"].sort(),
    );
    expect(report).toMatchObject({ outcome: "failed", refusal: null, exitCode: 3, attested: false, attestationUrl: null, tree, commit, warnings: [] });
    expect(report.durationMs).toEqual(expect.any(Number));
  });

  test("the argv is spawned with no shell: shell syntax reaches the program as plain arguments", async () => {
    const repo = await world.fixtureRepo({
      config: { suites: { unit: { command: ["node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "$HOME", "a && b", "*"] } } },
    });

    const result = await world.runCli(["exec", "unit"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["$HOME", "a && b", "*"]);
  });

  test("the command sees only the stripped environment plus the config's env, with a fresh HOME deleted afterwards", async () => {
    const script = "const fs = require('fs'); fs.writeFileSync(process.env.HOME + '/probe', 'x'); console.log(JSON.stringify(process.env))";
    const repo = await world.fixtureRepo({
      config: {
        env: { pass: ["DATABASE_URL", "NOT_IN_SHELL"], set: { NODE_ENV: "test" } },
        suites: { unit: { command: ["node", "-e", script], env: { pass: ["SUITE_ONLY"], set: { TZ: "Europe/Prague" } } } },
      },
    });

    const result = await world.runCli(["exec", "unit"], {
      cwd: repo.dir,
      env: {
        TERM: "xterm-256color",
        NO_COLOR: "1",
        DATABASE_URL: "postgres://localhost/test",
        SUITE_ONLY: "yes",
        SECRET_FROM_SHELL: "leak",
        TESTNOTARY_TOKEN: "tnl_should_never_reach_the_tests",
        LANG: "cs_CZ.UTF-8",
        CI: "",
      },
    });

    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.stdout) as Record<string, string>;
    // macOS's CoreFoundation adds this one inside every new process; it never comes from the shell.
    delete seen.__CF_USER_TEXT_ENCODING;
    expect(seen).not.toHaveProperty("SECRET_FROM_SHELL");
    expect(seen).not.toHaveProperty("TESTNOTARY_TOKEN");
    expect(Object.keys(seen).sort()).toEqual(["CI", "DATABASE_URL", "HOME", "LANG", "NODE_ENV", "NO_COLOR", "PATH", "SUITE_ONLY", "TERM", "TMPDIR", "TZ"]);
    expect(seen).toMatchObject({
      CI: "true",
      LANG: "C.UTF-8",
      TZ: "Europe/Prague",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      DATABASE_URL: "postgres://localhost/test",
      SUITE_ONLY: "yes",
      NODE_ENV: "test",
    });
    expect(seen.HOME).toMatch(/testnotary-home-/);
    expect(existsSync(seen.HOME!)).toBe(false);
  });

  test("a missing executable is refused as command_not_found with exit 2", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["no-such-test-runner", "run"] } } } });
    const commit = await repo.revParse("HEAD");
    const tree = await repo.tree();

    const result = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^testnotary: no-such-test-runner was not found on PATH/m);
    expect(lastLine(result.stderr)).toBe(`outcome=refused suite=unit attested=false tree=${tree} commit=${commit} url=`);
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "refused",
      refusal: "command_not_found",
      exitCode: null,
      attested: false,
      attestationUrl: null,
      tree,
      commit,
      durationMs: 0,
      warnings: [],
    });
  });

  test("a relative program path that doesn't exist is command_not_found", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["./node_modules/.bin/vitest"] } } } });

    const result = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "command_not_found" });
  });

  test("outside a git repo exec still runs the suite, with tree and commit left empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-exec-plain-"));
    try {
      await writeFile(join(dir, "testnotary.json"), JSON.stringify({ suites: { unit: nodeSuite("console.log('ok')") } }));

      const result = await world.runCli(["exec", "unit", "--json"], { cwd: dir });

      expect(result.exitCode).toBe(0);
      expect(lastLine(result.stderr)).toBe("outcome=passed suite=unit attested=false tree= commit= url=");
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", exitCode: 0, tree: null, commit: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exec reads the config from the checked-out tree and runs at the repo root, from a subdirectory too", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: nodeSuite("console.log(process.cwd())") } } });
    await repo.write({
      "testnotary.json": JSON.stringify({ suites: { unit: nodeSuite("console.log('local config: ' + process.cwd())") } }),
      "packages/a/index.js": "",
    });

    const result = await world.runCli(["exec", "unit"], { cwd: join(repo.dir, "packages", "a") });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`local config: ${repo.dir}\n`);
  });
});
