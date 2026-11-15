import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The action replacing a repo's test step (`mode: run`, the default): verify, then skip or run the
// suite through the library's `exec`, report, and write the PR line. Each story starts on a laptop
// that attests with `testnotary run`, then runs the action on a simulated runner whose workspace is
// a fresh checkout of the commit CI builds, with the library installed.

const world = useWorld();

/** A suite that leaves a mark in the workspace, so a test can tell whether the command ran. */
const MARKED = (exitCode = 0) => ({
  suites: { test: { command: ["node", "-e", `require('fs').writeFileSync('ran.txt', 'x'); process.exit(${exitCode})`] } },
});

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` in the fixture repo, on the developer's laptop; must attest. */
  attest(): Promise<void>;
}

let repos = 0;

/** An installed repo whose base config and `package.json` are given, and a signed-in writer. */
async function story(options: { config?: Record<string, unknown>; packageManager?: string | null } = {}): Promise<Story> {
  const n = ++repos;
  const packageJson = { name: "widgets", private: true, ...(options.packageManager === null ? {} : { packageManager: options.packageManager ?? "pnpm@10.34.9" }) };
  const fixture = await world.fixtureRepo({
    config: options.config ?? MARKED(),
    files: { "package.json": `${JSON.stringify(packageJson, null, 2)}\n`, ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `acme-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `acme-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    user,
    machine,
    async attest() {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
  };
}

/** A feature branch with one change, pushed, and the test merge commit GitHub builds for its PR. */
async function pullRequest(s: Story, files: Record<string, string> = { "src/a.js": "export const a = 1;\n" }) {
  await s.fixture.branch("feature");
  await s.fixture.commit("Add a", files);
  await s.fixture.push();
}

/** What `actions/checkout` and the install step leave on the runner: the commit, with the library installed. */
async function ciWorkspace(s: Story, sha: string, options: { library?: boolean } = {}): Promise<string> {
  const workspace = await s.fixture.ciCheckout(sha);
  if (options.library !== false) await installLibrary(workspace);
  return workspace;
}

/** Switches the repo to enforce mode, as an admin's setting change would (the toggle comes later). */
async function enforce(repo: FakeRepo) {
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
}

describe("the end-to-end story", () => {
  test("a laptop attests, then the action on the pull request's merge commit skips in enforce, exits 0 and writes the line", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", reason: "", ran: "false" });
    expect(result.packageManagerCalls).toEqual([]);
    const [check, ...more] = world.github.checkRuns(s.repo);
    expect(more).toEqual([]);
    expect(check).toMatchObject({ name: "Testnotary / test", headSha: merge.parents[1], status: "completed", conclusion: "success" });
    expect(check!.output.title).toMatch(new RegExp(`^Skipped · test passed .+ ago · attested by @${s.user.login} · laptop token "`));
    expect(result.summary).toContain(check!.output.title);
  });
});

describe("on a fallback the step runs the suite through the library", () => {
  test.each([
    { packageManager: "pnpm@10.34.9", form: ["pnpm", "exec", "testnotary"] },
    { packageManager: "yarn@4.9.2", form: ["yarn", "testnotary"] },
    { packageManager: "npm@11.6.0", form: ["npx", "--no-install", "testnotary"] },
    { packageManager: null, form: ["npx", "--no-install", "testnotary"] },
  ])("packageManager $packageManager: `$form exec` runs the tests and the step exits with their exit code", async ({ packageManager, form }) => {
    const s = await story({ packageManager, config: MARKED(3) });
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(3);
    expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
    expect(result.packageManagerCalls).toEqual([
      [...form, "--version"],
      [...form, "exec", "test", "--json"],
    ]);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ name: "Testnotary / test", conclusion: "neutral" });
    expect(check!.output.title).toMatch(/^Fell back: no_attestation, no passing run attested this tree · the tests failed in [\d.]+ s \(exit code 3\)$/);
  });

  test("a passing suite exits 0, and the line says the tests passed", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(/· the tests passed in [\d.]+ s$/);
  });
});

describe("setup errors", () => {
  test.each(["pnpm@10.34.9", "yarn@4.9.2", null])(
    "packageManager %s without the library installed: the step fails with a setup error and never runs the raw command",
    async (packageManager) => {
      const s = await story({ packageManager });
      await pullRequest(s);
      const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await ciWorkspace(s, merge.sha, { library: false });

      const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/^::error::Testnotary: the testnotary library was not found with `(pnpm exec|yarn|npx --no-install) testnotary`/m);
      expect(existsSync(join(workspace, "ran.txt"))).toBe(false);
      expect(result.packageManagerCalls.every((call) => call.at(-1) === "--version")).toBe(true);
      expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation", ran: "false" });
      expect(result.summary).toContain("Setup error");
    },
  );

  test("run mode on a Windows runner is a setup error, before any verification", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);
    const from = world.service.requests.length;

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" }, env: { RUNNER_OS: "Windows" } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^::error::Testnotary: run mode does not support Windows runners/m);
    expect(world.service.requests.slice(from)).toEqual([]);
    expect(existsSync(join(workspace, "ran.txt"))).toBe(false);
  });

  test("verify mode works on a Windows runner", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" }, env: { RUNNER_OS: "Windows" } });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation" });
  });
});

describe("the PR line", () => {
  test("a skip names the suite, age, account, token type and label, platform, Node and links the run page", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    const [check] = world.github.checkRuns(s.repo);
    const platform = `${process.platform}/${process.arch}`;
    const node = process.version.slice(1);
    expect(check!.output.title).toMatch(
      new RegExp(`^Skipped · test passed (under a minute|\\d+ min) ago · attested by @${s.user.login} · laptop token "[^"]+" · ${platform} · Node ${node.replace(/\./g, "\\.")}$`),
    );
    const runPage = new RegExp(`\\(${world.service.url}/${s.repo.owner}/widgets/runs/[0-9a-f-]{36}\\)`);
    expect(check!.output.summary).toMatch(runPage);
    expect(result.summary).toMatch(runPage);
  });
});
