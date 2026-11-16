import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installLibrary, installedProject, type FakeRepo, type FixtureRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// A change that could make CI behave differently from the run always runs the tests: a pull request
// that changes a guarded file (the product defaults, plus the repo's own globs from the config at
// the first parent) falls back with `guarded_file_changed`, naming the file; an attestation whose
// command isn't the base config's falls back with `command_changed`. Each story attests on a laptop
// first, so the attestation itself is valid.

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  /** `testnotary run` in the fixture repo, on the developer's laptop; must attest. */
  attest(): Promise<void>;
  /** The action in a gate job (`mode: verify`) on the commit `sha`. */
  gate(sha: string, options?: { event?: string; ref?: string }): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed repo whose base carries `config` and `files`, and a developer with write access signed in on their laptop. */
async function story(options: { config?: Record<string, unknown>; files?: Record<string, string>; mode?: "shadow" | "enforce" } = {}): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config ?? PASSING, files: { ".gitignore": "node_modules/\n", ...options.files } });
  const repo = await world.hostOnGitHub(fixture, { owner: `guard-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `guard-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `guard-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  if ((options.mode ?? "enforce") === "enforce") await enforce(repo);
  return {
    fixture,
    repo,
    async attest() {
      // The laptop runs Node 24, the Node the stories' .nvmrc and .node-version name.
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine, system: { node: "v24.11.0", lts: "Krypton" } });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
    gate: (sha, { event, ref } = {}) => world.runAction({ repo, sha, event, ref, workspace: fixture.dir, inputs: { suite: "test", mode: "verify" } }),
  };
}

/** Switches the repo to enforce mode, as an admin's setting change does. */
async function enforce(repo: FakeRepo) {
  await world.enforce(repo);
}

/**
 * A pull request: a pushed feature branch with one commit, attested on the laptop, and GitHub's
 * test merge commit for it. The repo's audit key version is one under which the attested tree is
 * not drawn for an audit: these tests are about guarded files, and audits have their own.
 */
async function attestedPullRequest(s: Story, files: Record<string, string | null>, installed?: (dir: string) => Record<string, string | Uint8Array>) {
  await s.fixture.branch("feature");
  await s.fixture.commit("Change things", files);
  await s.fixture.push();
  // A changed lockfile is installed on the laptop before the run, or the run is refused install_stale.
  if (installed) await s.fixture.write(installed(s.fixture.dir));
  await s.attest();
  await world.audits.forbid(s.repo);
  return s.fixture.testMerge({ base: "main", head: "feature" });
}

const PNPM = installedProject("pnpm");
const NPM = installedProject("npm");

/**
 * How a pull request changes a guarded file so that the laptop's run still passes the environment
 * floor (anything else: "changed"): a lockfile it installed, a Node version file naming the
 * laptop's Node, and a stray bun.lock in a repo whose package.json pins pnpm.
 */
const CHANGES: Record<string, { content: string; base?: Record<string, string>; installed?: (dir: string) => Record<string, string | Uint8Array> }> = {
  "testnotary.json": { content: `${JSON.stringify({ ...PASSING, guarded: [] })}\n` },
  "pnpm-lock.yaml": { content: PNPM.files["pnpm-lock.yaml"]!, installed: PNPM.installed },
  "package-lock.json": { content: NPM.files["package-lock.json"]!, installed: NPM.installed },
  "bun.lock": { content: "changed\n", base: { "package.json": '{ "name": "widgets", "private": true, "packageManager": "pnpm@10.34.9" }\n' } },
  ".nvmrc": { content: "24\n" },
  ".node-version": { content: "24\n" },
};

/** The PR line: the bold line of the job summary. */
function line(summary: string): string {
  return /\*\*(.+)\*\*/.exec(summary)?.[1] ?? "";
}

describe("a pull request that changes a product-default guarded file falls back, even with a valid attestation", () => {
  test.each([
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    "testnotary.json",
    ".testnotary/allowed_signers",
    "pnpm-lock.yaml",
    "package-lock.json",
    "packages/web/yarn.lock",
    "bun.lock",
    "package.json",
    "packages/api/package.json",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
  ])("%s", async (path) => {
    const change = CHANGES[path] ?? { content: "changed\n" };
    const s = await story({ files: change.base });
    const merge = await attestedPullRequest(s, { "src/a.js": "export const a = 1;\n", [path]: change.content }, change.installed);

    const result = await s.gate(merge.sha);

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed", skip: "false" });
    expect(line(result.summary)).toBe(`Fell back: guarded_file_changed (${path}), the pull request changes a guarded file`);
  });

  test("deleting the lockfile counts as changing it", async () => {
    const s = await story({ files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" } });
    const merge = await attestedPullRequest(s, { "pnpm-lock.yaml": null });

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed" });
    expect(line(result.summary)).toContain("guarded_file_changed (pnpm-lock.yaml)");
  });

  test("moving package.json away counts as changing it", async () => {
    const original = `${JSON.stringify({ name: "widgets", private: true, scripts: { test: "node --test" } }, null, 2)}\n`;
    const s = await story({ files: { "package.json": original } });
    const merge = await attestedPullRequest(s, { "package.json": null, "old/manifest.json": original });

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed" });
    expect(line(result.summary)).toContain("guarded_file_changed (package.json)");
  });

  test("in shadow mode it would have fallen back, naming the file", async () => {
    const s = await story({ mode: "shadow" });
    const merge = await attestedPullRequest(s, { "pnpm-lock.yaml": PNPM.files["pnpm-lock.yaml"]! }, PNPM.installed);

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "guarded_file_changed", skip: "false" });
    expect(line(result.summary)).toBe("Would have fallen back: guarded_file_changed (pnpm-lock.yaml), the pull request changes a guarded file");
  });

  test("a later step reads the file back from the recorded verification", async () => {
    const s = await story();
    const merge = await attestedPullRequest(s, { ".nvmrc": "24\n" });
    const gate = await s.gate(merge.sha);

    const token = await world.github.oidc.tokenFor({ repo: s.repo, sha: merge.sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
    const response = await fetch(`${world.service.url}/api/v1/verifications/${gate.outputs.verification}`, { headers: { authorization: `Bearer ${token}` } });

    expect(await response.json()).toMatchObject({ verification: { result: "fallback", reason: "guarded_file_changed", detail: ".nvmrc" } });
  });

  test("a pull request that changes more files than GitHub's compare lists (300) falls back too", async () => {
    const s = await story();
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/generated/file-${String(i).padStart(3, "0")}.js`, `export const n = ${i};\n`]));
    const merge = await attestedPullRequest(s, many);

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed" });
    expect(line(result.summary)).toContain("300");
  });
});

describe("a repo's own guarded globs", () => {
  test.each([
    { glob: "compose.yaml", path: "compose.yaml", guarded: true },
    { glob: "compose.yaml", path: "services/db/compose.yaml", guarded: true },
    { glob: "docker/**", path: "docker/db/init.sql", guarded: true },
    { glob: "docker", path: "docker/Dockerfile", guarded: true },
    { glob: "/scripts/*.sh", path: "scripts/setup.sh", guarded: true },
    { glob: "**/*.sql", path: "db/migrations/0001.sql", guarded: true },
    { glob: "config/{ci,test}.json", path: "config/test.json", guarded: true },
    { glob: "docker/**", path: "src/docker.js", guarded: false },
    { glob: "/scripts/*.sh", path: "tools/scripts/setup.sh", guarded: false },
    { glob: "config/{ci,test}.json", path: "config/dev.json", guarded: false },
  ])("$glob, a pull request changing $path: guarded $guarded", async ({ glob, path, guarded }) => {
    const s = await story({ config: { ...PASSING, guarded: [glob] } });
    const merge = await attestedPullRequest(s, { [path]: "changed\n" });

    const result = await s.gate(merge.sha);

    if (guarded) expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed" });
    else expect(result.outputs).toMatchObject({ result: "skip", reason: "" });
  });

  test("can't remove a product default", async () => {
    const s = await story({ config: { ...PASSING, guarded: ["!package.json", "!**/*.json"] } });
    const merge = await attestedPullRequest(s, { "package.json": "{}\n" });

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "guarded_file_changed" });
    expect(line(result.summary)).toContain("(package.json)");
  });

  test("count from the base's config: a glob the pull request adds doesn't guard its own files", async () => {
    // The pull request adds the glob, so it changes testnotary.json: that is what it names.
    const s = await story();
    const merge = await attestedPullRequest(s, { "testnotary.json": `${JSON.stringify({ ...PASSING, guarded: ["src/**"] })}\n`, "src/a.js": "x\n" });

    const result = await s.gate(merge.sha);

    expect(line(result.summary)).toContain("(testnotary.json)");
  });
});

describe("the attestation's command", () => {
  test("differs from the suite's command in the config at the first parent: command_changed", async () => {
    const s = await story();
    // The feature branch starts from the first main, as does a release branch; then main changes
    // the suite's command, and the developer, whose run reads the command from the fetched main,
    // attests the branch with it.
    await s.fixture.git("branch", "release", "main");
    await s.fixture.push("release");
    await s.fixture.branch("feature");
    await s.fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
    await s.fixture.push();
    await s.fixture.checkout("main");
    await s.fixture.commit("Change the test command", { "testnotary.json": `${JSON.stringify({ suites: { test: { command: ["node", "-e", "process.exit(0)", "changed"] } } })}\n` });
    await s.fixture.push();
    await s.fixture.checkout("feature");
    await s.attest();

    // CI on the pull request into the release branch builds the attested tree, whose first parent
    // (the release branch) has the old command.
    const merge = await s.fixture.testMerge({ base: "release", head: "feature" });
    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "command_changed", skip: "false" });
    expect(line(result.summary)).toBe("Fell back: command_changed, the attested command differs from testnotary.json on the base branch");
  });

  test("equal to the base config's command: skips", async () => {
    const s = await story();
    const merge = await attestedPullRequest(s, { "src/a.js": "export const a = 1;\n" });

    const result = await s.gate(merge.sha);

    expect(result.outputs).toMatchObject({ result: "skip", skip: "true" });
  });
});

describe("the setup pull request", () => {
  test("adds the config, the workflow, packageManager and the lockfile: its tests run in full and pass", async () => {
    const n = ++repos;
    const fixture = await world.fixtureRepo({
      config: null,
      files: { "package.json": `${JSON.stringify({ name: "widgets", private: true }, null, 2)}\n`, ".gitignore": "node_modules\nran.txt\n", "src/a.js": "export const a = 1;\n" },
    });
    const repo = await world.hostOnGitHub(fixture, { owner: `guard-setup-${n}`, name: "widgets" });
    await world.github.installApp({ account: { login: `guard-setup-${n}`, type: "Organization" }, repos: [repo] });
    await fixture.branch("setup");
    await fixture.commit("Set up Testnotary", {
      "testnotary.json": `${JSON.stringify({ suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "name: CI\non: [pull_request]\njobs: {}\n",
      "package.json": `${JSON.stringify({ name: "widgets", private: true, packageManager: "pnpm@10.34.9" }, null, 2)}\n`,
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    await fixture.push();
    const merge = await fixture.testMerge({ base: "main", head: "setup" });
    const workspace = await fixture.ciCheckout(merge.sha);
    await installLibrary(workspace);

    const result = await world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "guarded_file_changed", ran: "true" });
    const [check] = world.github.checkRuns(repo);
    expect(check).toMatchObject({ name: "Testnotary / test", conclusion: "neutral" });
    expect(check!.output.title).toMatch(
      /^Would have fallen back: guarded_file_changed \(\.github\/workflows\/ci\.yml\), the pull request changes a guarded file · shadow mode: the tests passed in [\d.]+ s$/,
    );
  });
});
