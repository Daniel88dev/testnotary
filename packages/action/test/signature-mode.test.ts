import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type SshKeyPair } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";
import type { Verification } from "@testnotary/protocol";

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
  /**
   * GitHub's test merge commit for the pull request, checked out with `fetch-depth: 2`, and the
   * action in run mode on it. The tree is never drawn for an audit, unless `audit`: then always.
   */
  ci(options?: { audit?: boolean }): Promise<Awaited<ReturnType<typeof world.runAction>> & { sha: string }>;
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
    async ci({ audit = false } = {}) {
      // These tests are about signatures; audits have their own.
      if (audit) await world.audits.force(repo);
      else await world.audits.forbid(repo);
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha, { fetchDepth: 2 });
      await installLibrary(workspace);
      return { ...(await world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" } })), sha: merge.sha };
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
    // The private half never left the laptop.
    const sent = world.service.requests.map((request) => request.text).join("\n");
    expect(sent).not.toContain("PRIVATE KEY");
    expect(sent).not.toContain(key.privateKey.split("\n")[1]);
  });

  test("an audit is still drawn by the service, and a failing one records a mismatch that copies the signature fields", async () => {
    // Passes on the laptop, fails in CI (where `local-only` is absent: it is ignored by git).
    const s = await scene({
      config: { signatures: "required", suites: { test: { command: ["node", "-e", "process.exit(require('fs').existsSync('local-only') ? 0 : 1)"] } } },
      files: { ".gitignore": "node_modules\nlocal-only\n" },
    });
    await s.fixture.write({ "local-only": "x" });
    const key = await world.sshKey();
    world.github.addSigningKey(s.user, key.publicKey);
    await useSigningKey(s.fixture, key);
    expect((await s.attest()).stderr).toMatch(/attested=true/);

    const result = await s.ci({ audit: true });

    expect(result.outputs).toMatchObject({ result: "audit", ran: "true" });
    expect(result.exitCode).toBe(1);
    const verificationId = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    const verification = await readBack(s.repo, result.sha, verificationId);
    expect(verification.attestation!.signature).toMatchObject({ keySource: "github", signer: { account: s.user.id }, githubListed: true });
    expect(verification.mismatch!.attestation.signature).toEqual(verification.attestation!.signature);
  });

  test("after the key is deleted on GitHub, the next check is signature_invalid and the tests run", async () => {
    const s = await scene();
    const key = await world.sshKey();
    const id = world.github.addSigningKey(s.user, key.publicKey);
    await useSigningKey(s.fixture, key);
    expect((await s.attest()).stderr).toMatch(/attested=true/);
    world.github.removeSigningKey(id);

    const result = await s.ci();

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", ran: "true" });
    expect(line(result.summary)).toBe(
      `Fell back: signature_invalid (signature: the key is neither among @${s.user.login}'s GitHub signing keys nor in .testnotary/allowed_signers at HEAD^1), the attestation's signature did not pass the signature check · the tests passed in ${duration(result.summary)}`,
    );
    expect(world.github.checkRuns(s.repo)[0]).toMatchObject({ conclusion: "neutral" });
  });
});

describe("a run with no usable signing key in signature mode", () => {
  test("uploads unsigned with a warning, and the action falls back with signature_missing", async () => {
    const s = await scene();

    const run = await world.runCli(["run", "--json"], { cwd: s.fixture.dir, machine: s.machine });

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: "passed", attested: true, warnings: ["no_signing_key"] });
    expect(run.stderr).toContain("testnotary: the repo requires signatures, but git has no SSH signing key");
    const [upload] = uploads(s.repo);
    expect(upload).toMatchObject({ outcome: "passed", warnings: ["no_signing_key"] });
    expect(upload!.attestation).toEqual({ payload: expect.any(String) });

    const result = await s.ci();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_missing", ran: "true" });
    expect(line(result.summary)).toMatch(/^Fell back: signature_missing, the repo requires signatures and the attestation has none · the tests passed in /);
    // The service answered skip; the job report says what the job did instead, so the dashboard
    // counts a fallback, not a skip.
    const verificationId = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    const [report] = world.service.requests.filter((request) => request.path === `/api/v1/verifications/${verificationId}/report`);
    expect(JSON.parse(report!.text)).toMatchObject({ outcome: "passed", result: "fallback", reason: "signature_missing", detail: null });
    const verification = await readBack(s.repo, result.sha, verificationId);
    expect(verification).toMatchObject({ result: "skip", jobReport: { outcome: "passed", result: "fallback", reason: "signature_missing" } });
  });

  test("a key ssh-keygen can't use also uploads unsigned with the warning", async () => {
    const s = await scene();
    await s.fixture.git("config", "gpg.format", "ssh");
    await s.fixture.git("config", "user.signingKey", "/nonexistent/key");

    const run = await world.runCli(["run", "--json"], { cwd: s.fixture.dir, machine: s.machine });

    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: "passed", attested: true, warnings: ["no_signing_key"] });
    expect(run.stderr).toMatch(/testnotary: the repo requires signatures, but ssh-keygen could not sign with \/nonexistent\/key/);
    expect(uploads(s.repo)[0]!.attestation).toEqual({ payload: expect.any(String) });
  });
});

describe("signature mode with a sandbox token's own key in allowed_signers", () => {
  /** What Codex cloud shows a process, with the vendor's secrets holding the token and the key. */
  const sandbox = (token: string, signingKey?: string) => ({ TESTNOTARY_SANDBOX: "1", CODEX_CI: "1", TESTNOTARY_TOKEN: token, TESTNOTARY_SIGNING_KEY: signingKey });

  test("sandbox-key makes the key and the line; once the line is on the base branch, the sandbox signs and CI skips", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.user, repo: s.repo, name: "codex-cloud" });

    // On the creator's laptop, in the repo: the key pair, and the line for a pull request.
    await s.fixture.checkout("main");
    const made = await world.runCli(["sandbox-key", "codex-cloud", "--json"], { cwd: s.fixture.dir, machine: s.machine });
    expect(made.exitCode).toBe(0);
    const answer = JSON.parse(made.stdout) as { token: { id: string; name: string; repository: string }; signingKey: string; allowedSignersLine: string; file: string };
    expect(answer.token).toMatchObject({ name: "codex-cloud", repository: s.repo.fullName });
    expect(answer.signingKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(answer.allowedSignersLine).toMatch(
      new RegExp(`^sandbox:${answer.token.id}/github:${s.user.id} namespaces="attestation@testnotary.dev" ssh-ed25519 [A-Za-z0-9+/]+=* sandbox token "codex-cloud" for ${s.repo.fullName}, created by @${s.user.login}$`),
    );
    expect(answer.file).toBe(".testnotary/allowed_signers");
    expect(await readFile(join(s.fixture.dir, ".testnotary/allowed_signers"), "utf8")).toBe(`${answer.allowedSignersLine}\n`);
    expect(made.stderr).toContain("TESTNOTARY_SIGNING_KEY");

    // The pull request adding the line merges; the agent's branch is on top of it.
    await s.fixture.commit("Trust the codex-cloud sandbox key");
    await s.fixture.push("main");
    await s.fixture.checkout("feature");
    await s.fixture.git("rebase", "--quiet", "main");
    await s.fixture.push("feature");

    const run = await world.runCli(["run"], { cwd: s.fixture.dir, machine: await world.machine(), env: sandbox(token, answer.signingKey) });
    expect(run.stderr).toMatch(/attested=true/);
    expect(run.stderr).toContain("(.testnotary/allowed_signers)");

    const result = await s.ci();

    expect(result.outputs).toMatchObject({ result: "skip", ran: "false" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(new RegExp(`^Skipped · .* · sandbox token "codex-cloud", created by @${s.user.login} · `));
    // The key came from the repo: no call for GitHub's keys, only the account and its permission.
    expect(world.github.requestsTo("GET", `/users/${s.user.login}/ssh_signing_keys`)).toHaveLength(0);
    // The service never received the private half.
    const sent = world.service.requests.map((request) => request.text).join("\n");
    expect(sent).not.toContain(answer.signingKey);
    expect(sent).not.toContain("PRIVATE KEY");
  });

  test("a sandbox without its key uploads unsigned with the warning, and CI falls back with signature_missing", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.user, repo: s.repo, name: "keyless" });

    const run = await world.runCli(["run", "--json"], { cwd: s.fixture.dir, machine: await world.machine(), env: sandbox(token) });
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: "passed", attested: true, warnings: ["no_signing_key"] });
    expect(run.stderr).toContain("TESTNOTARY_SIGNING_KEY is not set");

    const result = await s.ci();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_missing", ran: "true" });
  });
});

/** What a later step of the same repo's CI reads back about a verification, with its own fresh OIDC token. */
async function readBack(repo: FakeRepo, sha: string, id: string): Promise<Verification> {
  const token = await world.github.oidc.tokenFor({ repo, sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const response = await fetch(`${world.service.url}/api/v1/verifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { verification: Verification }).verification;
}

/** The PR line: the bold line of the job summary. */
function line(summary: string): string {
  return /\*\*(.+)\*\*/.exec(summary)?.[1] ?? "";
}

/** How long the tests took, as the line printed it. */
function duration(summary: string): string {
  return /the tests passed in ([\d.]+ s)/.exec(summary)?.[1] ?? "?";
}

/** Every run upload the service received for the repo, oldest first, as sent. */
function uploads(repo: FakeRepo): Record<string, unknown>[] {
  return world.service.requests
    .filter((request) => request.method === "POST" && request.path === "/api/v1/runs")
    .map((request) => JSON.parse(request.text) as Record<string, unknown>)
    .filter((upload) => upload.repository === repo.fullName);
}
