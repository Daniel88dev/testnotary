import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installLibrary, type ActionResult, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type RunActionOptions } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";
import { FALLBACK_REASONS, type FallbackReason } from "@testnotary/core";

// Every fallback reason code through the action's entry point, in one table: each case stages the
// cause, runs the action in run mode on GitHub's test merge commit, and checks that the tests ran
// and the PR line names the code. Several causes have deeper stories in other files (guarded
// files, signatures, audits, revocations); this table is where none can be missing.

const world = useWorld();

/** A suite that leaves a mark in the workspace, so a test can tell whether the command ran. */
const MARKED = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` on the developer's laptop, on the feature branch; must attest. */
  attest(env?: Record<string, string | undefined>): Promise<void>;
  /** The action in run mode on the pull request's test merge commit, with the library installed. */
  ci(options?: Partial<RunActionOptions> & { fetchDepth?: number; audit?: boolean }): Promise<ActionResult & { workspace: string }>;
}

let scenes = 0;

/** An installed repo in enforce mode with a pushed feature branch, and a writer signed in on their laptop. */
async function scene(options_: { config?: Record<string, unknown>; install?: boolean } = {}): Promise<Scene> {
  const options = options_;
  const n = ++scenes;
  const fixture = await world.fixtureRepo({
    config: options.config ?? MARKED,
    files: { "package.json": '{ "name": "relay", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `fallback-${n}`, name: "relay" });
  if (options.install !== false) await world.github.installApp({ account: { login: `fallback-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `fallback-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  if (options.install !== false) {
    const sql = world.db.connect("app");
    await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
              values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  }
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return {
    fixture,
    repo,
    user,
    machine,
    async attest(env) {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine, env });
      expect(result.stderr).toMatch(/attested=true/);
    },
    async ci({ fetchDepth, audit = false, ...options } = {}) {
      // Audits are drawn only where a case asks for one.
      if (audit) await world.audits.force(repo);
      else if (options_.install !== false) await world.audits.forbid(repo);
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha, fetchDepth ? { fetchDepth } : {});
      await installLibrary(workspace);
      const result = await world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" }, ...options });
      return { ...result, workspace };
    },
  };
}

interface Case {
  /** Stages the cause and runs the action. */
  run(): Promise<ActionResult & { workspace: string }>;
  /** What the line names in brackets after the code, when anything. */
  detail?: RegExp;
}

const CASES: Partial<Record<FallbackReason, Case>> = {
  disabled: {
    async run() {
      const s = await scene();
      return s.ci({ env: { TESTNOTARY_DISABLED: "true" } });
    },
  },
  host_not_supported: {
    async run() {
      const s = await scene();
      return s.ci({ env: { GITHUB_SERVER_URL: "https://ghes.example.com" } });
    },
  },
  no_oidc_token: {
    async run() {
      const s = await scene();
      return s.ci({ idToken: false });
    },
  },
};

/** Calls that left the runner for the service or for an OIDC token, from here on. */
function callsFrom(): () => { service: number; tokens: number } {
  const service = world.service.requests.length;
  const tokens = world.github.requestsTo("GET", "/oidc/_request").length;
  return () => ({ service: world.service.requests.length - service, tokens: world.github.requestsTo("GET", "/oidc/_request").length - tokens });
}

describe("before the service", () => {
  test("TESTNOTARY_DISABLED=true falls back with disabled, fetching no token and calling no service", async () => {
    const s = await scene();
    await s.attest();
    const calls = callsFrom();

    const result = await s.ci({ env: { TESTNOTARY_DISABLED: "true" } });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "disabled", ran: "true" });
    expect(calls()).toEqual({ service: 0, tokens: 0 });
    expect(result.summary).toContain("Fell back: disabled, TESTNOTARY_DISABLED is true");
  });

  test("a gate job with TESTNOTARY_DISABLED=true doesn't skip, and calls nothing either", async () => {
    const s = await scene();
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const calls = callsFrom();

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { suite: "test", mode: "verify" }, env: { TESTNOTARY_DISABLED: "true" } });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "disabled", skip: "false", verification: "" });
    expect(calls()).toEqual({ service: 0, tokens: 0 });
  });

  test("any other value of TESTNOTARY_DISABLED, or none, leaves the action on", async () => {
    const s = await scene();
    await s.attest();

    for (const value of ["", "false", "1"]) {
      const result = await s.ci({ env: { TESTNOTARY_DISABLED: value } });
      expect(result.outputs).toMatchObject({ result: "skip" });
    }
  });

  test("a GitHub Enterprise Server runner gets a notice and host_not_supported, without fetching a token", async () => {
    const s = await scene();
    await s.attest();
    const calls = callsFrom();

    const result = await s.ci({ env: { GITHUB_SERVER_URL: "https://ghes.example.com" } });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "host_not_supported", ran: "true" });
    expect(calls()).toEqual({ service: 0, tokens: 0 });
    expect(result.stdout).toMatch(/^::notice::Testnotary: v1 serves github\.com only, not https:\/\/ghes\.example\.com/m);
    expect(result.stdout).not.toMatch(/::warning::/);
  });

  test("the kill switch comes before the host check", async () => {
    const s = await scene();

    const result = await s.ci({ env: { TESTNOTARY_DISABLED: "true", GITHUB_SERVER_URL: "https://acme.ghe.com" } });

    expect(result.outputs).toMatchObject({ reason: "disabled" });
    expect(result.stdout).not.toMatch(/::notice::/);
  });

  test("a fork pull request has no OIDC token: a plain notice, no warning, and the tests run", async () => {
    const s = await scene();
    await s.attest();

    const result = await s.ci({ fork: true });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_oidc_token", ran: "true" });
    expect(result.stdout).toMatch(/^::notice::Testnotary: a pull request from a fork gets no OIDC token/m);
    expect(result.stdout).not.toMatch(/::warning::/);
  });

  test("a same-repo run without id-token: write gets a warning to add the permission", async () => {
    const s = await scene();
    await s.attest();

    const result = await s.ci({ idToken: false });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_oidc_token", ran: "true" });
    expect(result.stdout).toMatch(/^::warning::Testnotary: .*permissions: id-token: write/m);
    expect(result.stdout).not.toMatch(/::notice::/);
  });
});

describe("every fallback reason code runs the tests and names the code", () => {
  test.each(Object.entries(CASES) as [FallbackReason, Case][])("%s", async (code, { run, detail }) => {
    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.workspace, "ran.txt"))).toBe(true);
    const audit = code === "audit";
    expect(result.outputs).toMatchObject({ result: audit ? "audit" : "fallback", reason: code, ran: "true" });
    const title = result.summary.split("\n").find((line) => line.startsWith("**"))!.slice(2, -2);
    if (audit) expect(title).toMatch(/^Audit · /);
    else expect(title).toMatch(new RegExp(`^Fell back: ${code}${detail ? ` \\(${detail.source}\\)` : ""}, `));
  });
});

test("the table has a case for each of the 20 codes", () => {
  expect(FALLBACK_REASONS).toHaveLength(20);
  expect(Object.keys(CASES).sort()).toEqual([...FALLBACK_REASONS].sort());
});
