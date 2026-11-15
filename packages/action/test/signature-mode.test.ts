import { describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type SshKeyPair } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// Signature mode end to end: a repo whose base config says `"signatures": "required"`. The library
// signs each attestation with `ssh-keygen -Y sign`, and the action checks the signature itself
// (with keys from GitHub or from `.testnotary/allowed_signers` on the base branch) before it
// trusts a skip. Keys are made per test with the real `ssh-keygen`, in the world's temp directory.

const world = useWorld();

const SIGNED = {
  signatures: "required",
  suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } },
};

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` on the developer's laptop, on the pushed feature branch. */
  attest(env?: Record<string, string | undefined>): ReturnType<typeof world.runCli>;
  /** GitHub's test merge commit for the pull request, checked out with `fetch-depth: 2`, and the action in run mode on it. */
  ci(): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed repo in enforce mode whose base requires signatures, and a writer signed in on their laptop. */
async function scene(options: { config?: Record<string, unknown>; files?: Record<string, string> } = {}): Promise<Scene> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({
    config: options.config ?? SIGNED,
    files: { "package.json": '{ "name": "ledger", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n", ...options.files },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `sigmode-${n}`, name: "ledger" });
  await world.github.installApp({ account: { login: `sigmode-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `sigmode-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return {
    fixture,
    repo,
    user,
    machine,
    attest: (env) => world.runCli(["run"], { cwd: fixture.dir, machine, env }),
    async ci() {
      // These tests are about signatures; audits have their own.
      await world.audits.forbid(repo);
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha, { fetchDepth: 2 });
      await installLibrary(workspace);
      return world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" } });
    },
  };
}

/** Makes `key` the developer's git signing key in the repo, as `git config gpg.format ssh` + `user.signingKey` do. */
async function useSigningKey(fixture: FixtureRepo, key: SshKeyPair): Promise<void> {
  await fixture.git("config", "gpg.format", "ssh");
  await fixture.git("config", "user.signingKey", key.privateKeyPath);
}

describe("signature mode with the developer's GitHub SSH signing key", () => {
  test("the laptop signs, the action's signature check passes, and CI skips", async () => {
    const s = await scene();
    const key = await world.sshKey();
    world.github.addSigningKey(s.user, key.publicKey);
    await useSigningKey(s.fixture, key);

    const run = await s.attest();
    expect(run.stderr).toMatch(/attested=true/);
    expect(run.stderr).not.toMatch(/no_signing_key/);

    const result = await s.ci();

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", ran: "false" });
    expect(world.github.checkRuns(s.repo)[0]).toMatchObject({ conclusion: "success" });
    // The check asked GitHub itself, with the job's GITHUB_TOKEN: the account by id, then its
    // signing keys and its permission.
    const byJob = (path: string) => world.github.requestsTo("GET", path).filter((r) => r.headers.authorization?.startsWith("Bearer ghs_job_"));
    expect(byJob(`/user/${s.user.id}`)).toHaveLength(1);
    expect(byJob(`/users/${s.user.login}/ssh_signing_keys`)).toHaveLength(1);
    expect(byJob(`/repos/${s.repo.fullName}/collaborators/${s.user.login}/permission`)).toHaveLength(1);
  });
});
