import { describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// An agent attests from its cloud sandbox with a sandbox token, then CI on the pull request reads
// the attestation: it skips, and the PR line names the token and its creator, never the agent,
// with the agent's labels marked unverified.

const world = useWorld();

const SUITE = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };

/** What Codex cloud shows a process, with the vendor's secret holding the sandbox token. */
const CODEX_SANDBOX = { TESTNOTARY_SANDBOX: "1", CODEX_CI: "1", CODEX_THREAD_ID: "thr_6f2e91ac" };

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  creator: FakeAccount;
  token: string;
  /** `testnotary run` in the agent's sandbox, on the pull request's branch; must attest. */
  attest(): Promise<void>;
  /** The test merge commit of the pull request, and the action's run-mode step on it. */
  ci(): Promise<ReturnType<typeof world.runAction>>;
}

let repos = 0;

async function scene(): Promise<Scene> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({
    config: SUITE,
    files: { "package.json": '{ "name": "api", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `fernpay-${n}`, name: "api" });
  await world.github.installApp({ account: { login: `fernpay-${n}`, type: "Organization" }, repos: [repo] });
  const creator = world.github.addUser({ login: `devon-${n}` });
  world.github.setPermission(repo, creator, "write");
  const token = await world.sandboxToken({ creator, repo, name: "codex-cloud" });
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return {
    fixture,
    repo,
    creator,
    token,
    async attest() {
      const sandbox = await world.machine();
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine: sandbox, env: { ...CODEX_SANDBOX, TESTNOTARY_TOKEN: token } });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
    async ci() {
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha);
      await installLibrary(workspace);
      return world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" } });
    },
  };
}

describe("an attestation made with a sandbox token", () => {
  test("CI skips on it, and the line reads created by @user with the agent unverified", async () => {
    const s = await scene();
    await s.attest();

    const result = await s.ci();

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", ran: "false" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ conclusion: "success" });
    expect(check!.output.title).toMatch(
      new RegExp(`^Skipped · test passed .+ ago · sandbox token "codex-cloud", created by @${s.creator.login} · \\w+/\\w+ · Node [\\d.]+ · agent Codex \\(unverified\\)$`),
    );
    expect(check!.output.title).not.toMatch(/attested by/);
    expect(check!.output.summary).toContain("- Agent session (unverified): Codex, session thr_6f2e91ac");
    expect(result.summary).toContain(check!.output.title);
  });

  test("when its creator loses write access, CI falls back with attester_no_write and runs the tests", async () => {
    const s = await scene();
    await s.attest();
    world.github.setPermission(s.repo, s.creator, "read");

    const result = await s.ci();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attester_no_write", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(/^Fell back: attester_no_write, the attester no longer has write access · /);
  });

  test("when its creator loses write access, the sandbox can no longer attest", async () => {
    const s = await scene();
    world.github.setPermission(s.repo, s.creator, "none");
    const sandbox = await world.machine();

    const result = await world.runCli(["run", "--json"], { cwd: s.fixture.dir, machine: sandbox, env: { ...CODEX_SANDBOX, TESTNOTARY_TOKEN: s.token } });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "no_write_access", attested: false });
  });
});
