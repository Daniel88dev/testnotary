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

/**
 * Switches the repo to enforce mode, as an admin's setting change would (the toggle comes later),
 * with a key version under which no tree attested so far is drawn for an audit: the skip tests
 * here are about skipping, and audits have their own (audit.test.ts).
 */
async function enforce(repo: FakeRepo) {
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  await world.audits.forbid(repo);
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

/** The recorded verification a later step of the repo's CI reads back with its own fresh OIDC token. */
async function readBack(repo: FakeRepo, sha: string, id: string): Promise<{ status: number; verification?: Record<string, unknown> }> {
  const token = await world.github.oidc.tokenFor({ repo, sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const response = await fetch(`${world.service.url}/api/v1/verifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, ...((await response.json()) as { verification?: Record<string, unknown> }) };
}

/** The service calls a step made since `from`, as `METHOD path`. */
function callsSince(from: number): string[] {
  return world.service.requests.slice(from).map((r) => `${r.method} ${r.path}`);
}

describe("the gate recipe", () => {
  test("the test step reuses the gate job's verification id: it reads it back, verifies nothing anew, and reports against it", async () => {
    const s = await story({ config: MARKED(0) });
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const gate = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" } });
    expect(gate.outputs).toMatchObject({ result: "would_skip", skip: "false" });
    const id = gate.outputs.verification!;
    const workspace = await ciWorkspace(s, merge.sha);
    const from = world.service.requests.length;

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test", verification: id } });

    expect(callsSince(from)).toEqual([`GET /api/v1/verifications/${id}`, `POST /api/v1/verifications/${id}/report`]);
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "would_skip", reason: "", ran: "true" });
    expect((await readBack(s.repo, merge.sha, id)).verification).toMatchObject({ jobReport: { outcome: "passed" } });
  });

  test("an empty verification id (the gate failed) makes the step verify on its own", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);
    const from = world.service.requests.length;

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test", verification: "" } });

    expect(callsSince(from)[0]).toBe("POST /api/v1/verifications");
    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation", ran: "true" });
  });

  test("a verification id of another commit is not reused: the step verifies on its own", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const gate = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" } });
    await s.fixture.commit("Change a", { "src/a.js": "export const a = 2;\n" });
    await s.fixture.push();
    const next = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, next.sha);
    const from = world.service.requests.length;

    await world.runAction({ repo: s.repo, sha: next.sha, workspace, inputs: { suite: "test", verification: gate.outputs.verification! } });

    expect(callsSince(from).slice(0, 2)).toEqual([`GET /api/v1/verifications/${gate.outputs.verification}`, "POST /api/v1/verifications"]);
  });

  test("a gate job that skips writes the PR line itself, since the test job won't run", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);

    const gate = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" } });

    expect(gate.outputs).toMatchObject({ result: "skip", skip: "true" });
    const [check, ...more] = world.github.checkRuns(s.repo);
    expect(more).toEqual([]);
    expect(check).toMatchObject({ name: "Testnotary / test", conclusion: "success" });
    expect(gate.summary).toContain(check!.output.title);
  });

  test("a gate job that does not skip writes only its job summary: the test job makes the check run", async () => {
    const s = await story();
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const gate = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" } });

    expect(world.github.checkRuns(s.repo)).toEqual([]);
    expect(gate.summary).toContain("Would have fallen back: no_attestation");
  });
});

describe("the job report", () => {
  test("after the tests ran, one call stores the outcome, duration and runner environment against the verification", async () => {
    const s = await story({ config: MARKED(3) });
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);
    const from = world.service.requests.length;

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    const reports = world.service.requests.slice(from).filter((r) => r.method === "POST" && /^\/api\/v1\/verifications\/[^/]+\/report$/.test(r.path));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const sent = JSON.parse(reports[0]!.text) as Record<string, unknown>;
    expect(sent).toEqual({
      outcome: "failed",
      durationMs: expect.any(Number) as number,
      environment: { os: "Linux", arch: "X64", image: null, imageVersion: null, node: process.version },
      result: "would_fall_back",
      reason: "no_attestation",
      detail: null,
    });
    const verificationId = /^\/api\/v1\/verifications\/([^/]+)\/report$/.exec(reports[0]!.path)![1]!;
    const read = await readBack(s.repo, merge.sha, verificationId);
    expect(read.verification).toMatchObject({ result: "would_fall_back", jobReport: { outcome: "failed", durationMs: sent.durationMs } });
    expect(result.exitCode).toBe(3);
  });

  test("a skip sends no report: no tests ran", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);
    const from = world.service.requests.length;

    await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(world.service.requests.slice(from).filter((r) => r.path.endsWith("/report"))).toEqual([]);
  });

  test("a report the service refuses only warns: the step still exits with the tests' exit code, and the verification shows no outcome", async () => {
    const s = await story({ config: MARKED(3) });
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);
    // The second token the job asks for (the report's) names another commit, so the service
    // finds no verification of it to report on.
    let tokens = 0;
    const restore = world.github.override("GET", "/oidc/_request", async ({ request, url, github }) => {
      const job = github.oidc.job(/^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")![1]!)!;
      const sha = ++tokens === 1 ? job.sha : "0".repeat(40);
      return Response.json({ count: 1, value: await github.oidc.tokenFor({ ...job, sha }, url.searchParams.get("audience") ?? undefined) });
    });
    const from = world.service.requests.length;
    let result;
    try {
      result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });
    } finally {
      restore();
    }

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toMatch(/^::warning::Testnotary: the job report did not reach the service \(the service answered 404\); the verification shows "outcome unknown"\./m);
    expect(result.outputs).toMatchObject({ result: "would_fall_back", ran: "true" });
    const report = world.service.requests.slice(from).find((r) => r.path.endsWith("/report"))!;
    const verificationId = /^\/api\/v1\/verifications\/([^/]+)\/report$/.exec(report.path)![1]!;
    expect((await readBack(s.repo, merge.sha, verificationId)).verification).toMatchObject({ jobReport: null });
  });
});

describe("the job tests the verified tree, or falls back", () => {
  /** Passes where `src/a.js` exists (the attested pull request), fails where it doesn't. */
  const NEEDS_A = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x'); process.exit(require('fs').existsSync('src/a.js') ? 0 : 1)"] } } };

  test("a checkout of another ref than the commit verified (`actions/checkout` with `ref:`) falls back and runs the tests", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    // The job checks out the base branch, not GITHUB_SHA.
    const workspace = await ciWorkspace(s, await s.fixture.revParse("main"));

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(/^Fell back: no_attestation \(the checked-out tree is not the verified tree\), no passing run attested this tree · the tests passed in /);
    // The service answered skip; the report says the job fell back, so the dashboard counts a fallback.
    const id = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    expect((await readBack(s.repo, merge.sha, id)).verification).toMatchObject({ result: "skip", jobReport: { result: "fallback", reason: "no_attestation" } });
  });

  test("an audit on another tree records no mismatch when its tests fail: they tested something else", async () => {
    const s = await story({ config: NEEDS_A });
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    await world.audits.force(s.repo);
    const workspace = await ciWorkspace(s, await s.fixture.revParse("main"));

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]).toMatchObject({ conclusion: "neutral" });
    const id = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    expect((await readBack(s.repo, merge.sha, id)).verification).toMatchObject({ result: "audit", mismatch: null, jobReport: { outcome: "failed", result: "fallback" } });
  });

  test("pull_request_target, whose GITHUB_SHA is the base's head while the job tests a fork's code, falls back", async () => {
    const s = await story({ config: NEEDS_A });
    await pullRequest(s);
    await s.attest();
    // The maintainer's attested work is on the base branch; a fork's pull request deletes src/a.js.
    await s.fixture.git("push", "--quiet", "origin", "feature:main");
    const base = await s.fixture.revParse("feature");
    await enforce(s.repo);
    await s.fixture.branch("fork-change");
    await s.fixture.git("rm", "--quiet", "src/a.js");
    await s.fixture.commit("Drop a");
    await s.fixture.push("fork-change");
    const workspace = await ciWorkspace(s, await s.fixture.revParse("fork-change"));

    const result = await world.runAction({ repo: s.repo, sha: base, event: "pull_request_target", workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(/^Fell back: no_attestation \(event pull_request_target is not verified\), /);
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

  test("names the token by its current name, after its owner renamed it", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const sql = world.db.connect("app");
    await sql`insert into token_renames (token_id, name) select id, 'work laptop' from tokens where account_id = ${s.user.id}`;
    const workspace = await ciWorkspace(s, merge.sha);

    await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(world.github.checkRuns(s.repo)[0]!.output.title).toContain(`attested by @${s.user.login} · laptop token "work laptop" · `);
  });

  test("in shadow mode a run the attestation covers reads would_skip, runs the tests, and names both", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ result: "would_skip", reason: "", ran: "true" });
    expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ conclusion: "success" });
    expect(check!.output.title).toMatch(new RegExp(`^Would have skipped · test passed .+ ago · attested by @${s.user.login} · .+ · shadow mode: the tests passed in [\\d.]+ s$`));
  });

  test("without checks: write the step makes no check run, and still writes the job summary", async () => {
    const s = await story();
    await pullRequest(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" }, checks: false });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip" });
    expect(world.github.checkRuns(s.repo)).toEqual([]);
    expect(result.stdout).not.toMatch(/::(warning|error)::/);
    expect(result.summary).toMatch(/\*\*Skipped · test passed/);
  });

  test("a fork pull request gets a read-only token: no check run, and the tests run as usual", async () => {
    const s = await story({ config: MARKED(0) });
    await pullRequest(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await ciWorkspace(s, merge.sha);

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" }, fork: true });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_oidc_token", ran: "true" });
    expect(world.github.checkRuns(s.repo)).toEqual([]);
    expect(result.summary).toContain("Fell back: no_oidc_token");
  });
});
