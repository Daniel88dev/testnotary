import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig, workflowSnippet } from "@testnotary/core";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: "shop", private: true, ...fields }, null, 2)}\n`;
}

async function read(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), "utf8");
}

describe("testnotary init --yes", () => {
  test("writes testnotary.json with one suite test that runs scripts.test through the pinned package manager", async () => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ packageManager: "pnpm@10.34.9", scripts: { test: "vitest run" } }) },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    const text = await read(repo.dir, "testnotary.json");
    const parsed = parseConfig(text);
    expect(parsed).toEqual({
      ok: true,
      config: { $schema: "https://testnotary.dev/schema/v1.json", suites: { test: { command: ["pnpm", "run", "test"] } } },
    });
  });

  test.each([
    { lockfile: "yarn.lock", command: ["yarn", "test"] },
    { lockfile: "package-lock.json", command: ["npm", "test"] },
    { lockfile: "pnpm-lock.yaml", command: ["pnpm", "run", "test"] },
    { lockfile: null, command: ["npm", "test"] },
  ])("with no pin, the lockfile $lockfile names the package manager", async ({ lockfile, command }) => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "node --test" } }), ...(lockfile ? { [lockfile]: "" } : {}) },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await read(repo.dir, "testnotary.json"))).toMatchObject({ suites: { test: { command } } });
  });

  test("run from a subdirectory, it writes at the repo's top level", async () => {
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "node --test" } }), "src/index.js": "" },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: join(repo.dir, "src") });

    expect(result.exitCode).toBe(0);
    expect(parseConfig(await read(repo.dir, "testnotary.json")).ok).toBe(true);
  });

  test.each([
    { case: "no package.json", files: {} as Record<string, string>, says: "no package.json" },
    { case: "no scripts.test", files: { "package.json": manifest({ scripts: { build: "tsc" } }) }, says: "scripts.test" },
    { case: "a Bun pin", files: { "package.json": manifest({ packageManager: "bun@1.2.0", scripts: { test: "bun test" } }) }, says: "bun" },
  ])("with $case it writes nothing, says why and exits 1", async ({ files, says }) => {
    const repo = await world.fixtureRepo({ config: null, files });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(says);
    expect(await repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("an existing testnotary.json is left as it is", async () => {
    const existing = `${JSON.stringify({ suites: { unit: { command: ["node", "--test"] } } }, null, 2)}\n`;
    const repo = await world.fixtureRepo({
      config: null,
      files: { "package.json": manifest({ scripts: { test: "vitest run" } }), "testnotary.json": existing },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, "testnotary.json")).toBe(existing);
    expect(result.stderr).toContain("testnotary.json already exists");
  });
});

// The block as the docs show it for pnpm and the suite `test` (apps/web: the setup guide's AGENTS.md panel).
const PNPM_BLOCK = [
  "## Tests",
  "",
  "Before you open or update a pull request, commit your work and run:",
  "",
  "    pnpm exec testnotary run test",
  "",
  "Run it exactly like that, with no extra arguments. If the last line",
  "says outcome=refused, run `pnpm exec testnotary check test` and fix",
  "what it names. If it says outcome=failed, fix the tests.",
].join("\n");

const PNPM_PACKAGE = manifest({ packageManager: "pnpm@10.34.9", scripts: { test: "vitest run" } });

describe("the agent block", () => {
  test("goes into a new AGENTS.md when the repo has no CLAUDE.md", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, "AGENTS.md")).toBe(`${PNPM_BLOCK}\n`);
  });

  test("is appended to CLAUDE.md when the repo has one, keeping what is there, and AGENTS.md is not created", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE, "CLAUDE.md": "# Shop\n\nUse pnpm." } });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, "CLAUDE.md")).toBe(`# Shop\n\nUse pnpm.\n\n${PNPM_BLOCK}\n`);
    expect(existsSync(join(repo.dir, "AGENTS.md"))).toBe(false);
  });

  test("is appended to an existing AGENTS.md, and a second init adds nothing twice", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE, "AGENTS.md": "# Shop\n" } });

    await world.runCli(["init", "--yes"], { cwd: repo.dir });
    const again = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(again.exitCode).toBe(0);
    expect(await read(repo.dir, "AGENTS.md")).toBe(`# Shop\n\n${PNPM_BLOCK}\n`);
  });

  test("names the suite an existing testnotary.json declares", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["pnpm", "run", "test:unit"] } } }, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, "AGENTS.md")).toContain("    pnpm exec testnotary run unit\n");
    expect(result.stdout).toContain("          suite: unit");
  });
});

describe("testnotary init, interactive", () => {
  const CONFIG_QUESTION = 'Write testnotary.json with suite "test" (pnpm run test)? [Y/n]';
  const BLOCK_QUESTION = "Add the Testnotary block to AGENTS.md? [Y/n]";

  test("asks before writing each file, and writes only what was agreed to", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init"], { cwd: repo.dir, input: "y\nn\n" });

    expect(result.exitCode).toBe(0);
    const err = result.stderr;
    expect(err.indexOf(CONFIG_QUESTION)).toBeGreaterThan(-1);
    expect(err.indexOf(CONFIG_QUESTION)).toBeLessThan(err.indexOf("testnotary: wrote testnotary.json"));
    expect(err.indexOf("testnotary: wrote testnotary.json")).toBeLessThan(err.indexOf(BLOCK_QUESTION));
    expect(err).toContain("testnotary: AGENTS.md not changed");
    expect(parseConfig(await read(repo.dir, "testnotary.json")).ok).toBe(true);
    expect(existsSync(join(repo.dir, "AGENTS.md"))).toBe(false);
    // Declined, the block is printed to paste by hand, before the workflow snippet.
    expect(result.stdout).toContain(`add this to AGENTS.md:\n\n${PNPM_BLOCK}\n`);
    expect(result.stdout).toContain("Next steps:");
  });

  test("a no to the config still offers the agent block, and asks about CLAUDE.md when the repo has one", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE, "CLAUDE.md": "# Shop\n" } });

    const result = await world.runCli(["init"], { cwd: repo.dir, input: "n\nyes\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Add the Testnotary block to CLAUDE.md? [Y/n]");
    expect(existsSync(join(repo.dir, "testnotary.json"))).toBe(false);
    expect(await read(repo.dir, "CLAUDE.md")).toBe(`# Shop\n\n${PNPM_BLOCK}\n`);
  });

  test("an empty answer takes the default, and an unclear one is asked again", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init"], { cwd: repo.dir, input: "\nmaybe\nY\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.split(BLOCK_QUESTION)).toHaveLength(3);
    expect(parseConfig(await read(repo.dir, "testnotary.json")).ok).toBe(true);
    expect(await read(repo.dir, "AGENTS.md")).toBe(`${PNPM_BLOCK}\n`);
  });

  test("with no answers at all it writes nothing", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init"], { cwd: repo.dir, input: "" });

    expect(result.stderr).toContain(CONFIG_QUESTION);
    expect(await repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

/** stdout must be exactly one JSON object on one line, and nothing else. */
function onlyJson(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  const value: unknown = JSON.parse(stdout);
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

describe("testnotary init --json", () => {
  test("with --yes, stdout is one object saying what was detected, written and what is left to do", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE, ".nvmrc": "24\n" } });

    const result = await world.runCli(["init", "--yes", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    const report = onlyJson(result.stdout);
    expect(report).toEqual({
      root: repo.dir,
      packageManager: "pnpm",
      config: { path: "testnotary.json", status: "written" },
      suite: { name: "test", command: ["pnpm", "run", "test"] },
      agentFile: { path: "AGENTS.md", status: "added", block: PNPM_BLOCK },
      workflowSnippet: workflowSnippet({ packageManager: "pnpm", suite: "test", nodeVersionFile: ".nvmrc", defaultBranch: "main" }),
      nextSteps: expect.arrayContaining([expect.stringContaining("Install the Testnotary GitHub App"), expect.stringContaining("pnpm exec testnotary login")]),
    });
    expect(report.workflowSnippet).toContain("  id-token: write");
    // The people's lines stay on stderr, prefixed.
    expect(result.stderr).toContain("testnotary: wrote testnotary.json\n");
    expect(result.stderr).toContain("testnotary: wrote AGENTS.md\n");
    expect(parseConfig(await read(repo.dir, "testnotary.json")).ok).toBe(true);
  });

  test("an existing config and agent block are reported as already there, with the config's own suite", async () => {
    const repo = await world.fixtureRepo({
      config: { suites: { unit: { command: ["pnpm", "run", "test:unit"] } } },
      files: { "package.json": PNPM_PACKAGE, "CLAUDE.md": "Run `pnpm exec testnotary run unit` before you push.\n" },
    });

    const result = await world.runCli(["init", "--yes", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(onlyJson(result.stdout)).toMatchObject({
      config: { path: "testnotary.json", status: "existed" },
      suite: { name: "unit", command: ["pnpm", "run", "test:unit"] },
      agentFile: { path: "CLAUDE.md", status: "present" },
    });
  });

  test("interactive answers still leave stdout to the one object, with the questions on stderr", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    const result = await world.runCli(["init", "--json"], { cwd: repo.dir, input: "n\nn\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Write testnotary.json with suite "test" (pnpm run test)? [Y/n]');
    expect(onlyJson(result.stdout)).toMatchObject({
      config: { path: "testnotary.json", status: "declined" },
      agentFile: { path: "AGENTS.md", status: "declined", block: PNPM_BLOCK },
    });
    expect(await repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test.each<{ case: string; files: Record<string, string>; expected: Record<string, unknown> }>([
    { case: "no package.json", files: {}, expected: { error: "no_package_json" } },
    {
      case: "no scripts.test",
      files: { "package.json": manifest({ packageManager: "yarn@4.5.3", scripts: { build: "tsc" } }) },
      expected: { error: "no_test_script", packageManager: "yarn" },
    },
    {
      case: "a Bun pin",
      files: { "package.json": manifest({ packageManager: "bun@1.2.0", scripts: { test: "bun test" } }) },
      expected: { error: "package_manager_unsupported", packageManager: "bun" },
    },
    {
      case: "an invalid testnotary.json",
      files: { "package.json": PNPM_PACKAGE, "testnotary.json": '{ "sutes": {} }\n' },
      expected: { error: "config_invalid", packageManager: "pnpm", problems: expect.arrayContaining([expect.stringContaining('unknown key "sutes"')]) },
    },
  ])("with $case it exits 1 with an error code and writes nothing", async ({ files, expected }) => {
    const repo = await world.fixtureRepo({ config: null, files });
    const before = await repo.git("status", "--porcelain", "--untracked-files=all");

    const result = await world.runCli(["init", "--yes", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(1);
    expect(onlyJson(result.stdout)).toEqual(expected);
    expect(result.stderr).toMatch(/^testnotary: /m);
    expect(await repo.git("status", "--porcelain", "--untracked-files=all")).toBe(before);
  });
});

describe("what init prints", () => {
  test("it never touches .github/workflows and prints the snippet and the next steps", async () => {
    const workflow = "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n";
    const repo = await world.fixtureRepo({
      config: null,
      defaultBranch: "trunk",
      files: { "package.json": PNPM_PACKAGE, ".nvmrc": "24\n", ".github/workflows/ci.yml": workflow },
    });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(await read(repo.dir, ".github/workflows/ci.yml")).toBe(workflow);
    const changed = (await repo.git("status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort();
    expect(changed).toEqual(["?? AGENTS.md", "?? testnotary.json"]);

    const out = result.stdout;
    // The triggers, the three permissions (open decision 1) and the kill switch.
    expect(out).toContain("on:\n  pull_request:\n  push:\n    branches: [trunk]\n  merge_group:");
    expect(out).toMatch(/^permissions:\n {2}contents: read\n {2}id-token: write +#.*\n {2}checks: write +#.*$/m);
    expect(out).toContain("env:\n  TESTNOTARY_DISABLED: ${{ vars.TESTNOTARY_DISABLED }}");
    expect(out).toContain("node-version-file: .nvmrc");
    expect(out).toContain("- run: pnpm install --frozen-lockfile");
    expect(out).toContain("uses: Daniel88dev/testnotary@v1\n        with:\n          suite: test");
    // The snippet is the docs' own text, from the one definition in core.
    expect(out).toContain(workflowSnippet({ packageManager: "pnpm", suite: "test", nodeVersionFile: ".nvmrc", defaultBranch: "trunk" }));

    expect(out).toContain("Next steps:");
    expect(out).toContain("Install the Testnotary GitHub App");
    expect(out).toContain("pnpm exec testnotary login");
    expect(out).toContain("pnpm exec testnotary run test");
    expect(out).toContain("https://testnotary.dev/docs/agents");
    expect(out).toContain("https://testnotary.dev/docs/setup");
    expect(out).not.toContain("Pin ");
  });

  test("an unpinned repo is told to pin Node and the package manager", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": manifest({ scripts: { test: "node --test" } }), "package-lock.json": "" } });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Pin Node in \.nvmrc and the package manager .*"npm@/);
    expect(result.stdout).toContain("- run: npm ci");
  });

  test("it starts no package manager", async () => {
    const machine = await world.machine();
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE, "pnpm-lock.yaml": "" } });

    const result = await world.runCli(["init", "--yes"], { cwd: repo.dir, machine });

    expect(result.exitCode).toBe(0);
    expect(await machine.packageManagerCalls()).toEqual([]);
  });

  test("anything but --yes and --json is a usage error, with nothing on stdout", async () => {
    const repo = await world.fixtureRepo({ config: null, files: { "package.json": PNPM_PACKAGE } });

    for (const args of [["init", "unit"], ["init", "--force", "--json"]]) {
      const result = await world.runCli(args, { cwd: repo.dir });
      expect(result.exitCode).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage: testnotary init [--yes] [--json]");
    }
    expect(existsSync(join(repo.dir, "testnotary.json"))).toBe(false);
  });
});
