import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fromJob, githubError, installLibrary, type ActionResult, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type RunActionOptions, type SshKeyPair, type SystemOptions } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";
import { FALLBACK_REASONS, type FallbackReason } from "@testnotary/core";

// Every fallback reason code through the action's entry point, in one table: each case stages the
// cause, runs the action in run mode on GitHub's test merge commit, and checks that the tests ran
// and the PR line names the code. Several causes have deeper stories in other files (guarded
// files, signatures, audits, revocations); this table is where none can be missing.

const world = useWorld();

/** A suite that leaves a mark in the workspace, so a test can tell whether the command ran. */
const MARKED = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };

/** What a case hands back: the step's result, its workspace, the commit CI built and the repo. */
type CiResult = ActionResult & { workspace: string; sha: string; repo: FakeRepo };

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` on the developer's laptop, on the feature branch; must attest. `system`: the laptop's Node (faked). */
  attest(env?: Record<string, string | undefined>, system?: SystemOptions): Promise<void>;
  /** The action in run mode on the pull request's test merge commit, with the library installed. */
  ci(options?: Partial<RunActionOptions> & { fetchDepth?: number; audit?: boolean }): Promise<CiResult>;
}

let scenes = 0;

/** An installed repo in enforce mode with a pushed feature branch, and a writer signed in on their laptop. */
async function scene(options: { config?: Record<string, unknown>; install?: boolean } = {}): Promise<Scene> {
  const installed = options.install !== false;
  const n = ++scenes;
  const fixture = await world.fixtureRepo({
    config: options.config ?? MARKED,
    files: { "package.json": '{ "name": "relay", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `fallback-${n}`, name: "relay" });
  if (installed) await world.github.installApp({ account: { login: `fallback-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `fallback-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  if (installed) {
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
    async attest(env, system) {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine, env, system });
      expect(result.stderr).toMatch(/attested=true/);
    },
    async ci({ fetchDepth, audit = false, ...options } = {}) {
      // Audits are drawn only where a case asks for one.
      if (audit) await world.audits.force(repo);
      else if (installed) await world.audits.forbid(repo);
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha, fetchDepth ? { fetchDepth } : {});
      await installLibrary(workspace);
      const result = await world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" }, ...options });
      return { ...result, workspace, sha: merge.sha, repo };
    },
  };
}

interface Case {
  /** Stages the cause and runs the action. */
  run(): Promise<CiResult>;
  /** What the line names in brackets after the code, when anything. */
  detail?: RegExp;
}

const CASES: Record<FallbackReason, Case> = {
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
  service_unreachable: {
    async run() {
      const s = await scene();
      await s.attest();
      return s.ci({ env: { TESTNOTARY_URL: "http://127.0.0.1:9" } });
    },
  },
  service_error: {
    async run() {
      const s = await scene();
      await s.attest();
      return during(world.service.override("POST", "/api/v1/verifications", () => Response.json({ error: "internal" }, { status: 500 })), () => s.ci());
    },
  },
  timeout: {
    async run() {
      const s = await scene();
      await s.attest();
      return during(
        world.service.override("POST", "/api/v1/verifications", async (request) => {
          await world.service.stall(request);
          return "drop" as const;
        }),
        () => s.ci(),
      );
    },
  },
  repo_not_installed: {
    async run() {
      const s = await scene({ install: false });
      return s.ci();
    },
  },
  token_rejected: {
    async run() {
      const s = await scene();
      await s.attest();
      // An issuer with two segments after the root: no enterprise slug, so not GitHub's.
      return s.ci({ enterpriseSlug: "acme/extra" });
    },
  },
  github_denied: {
    async run() {
      const s = await scene();
      await s.attest();
      return during(denyByIpAllowList(s.repo), () => s.ci());
    },
    detail: /an IP allow list blocks the service/,
  },
  unknown_suite: {
    async run() {
      // The pull request adds the suite to its own testnotary.json; the base's config decides.
      const s = await scene();
      await s.fixture.commit("Add an e2e suite", { "testnotary.json": `${JSON.stringify({ suites: { ...MARKED.suites, e2e: MARKED.suites.test } })}\n` });
      await s.fixture.push();
      await s.attest();
      return s.ci({ inputs: { suite: "e2e" } });
    },
  },
  no_attestation: {
    async run() {
      const s = await scene();
      return s.ci();
    },
  },
  attestation_expired: {
    async run() {
      const s = await scene();
      await s.attest();
      world.clock.advance(24 * 60 * 60 * 1000 + 60_000);
      return s.ci();
    },
  },
  attestation_revoked: {
    async run() {
      const s = await scene();
      await s.attest();
      expect((await world.runCli(["logout"], { cwd: s.machine.home, machine: s.machine })).exitCode).toBe(0);
      return s.ci();
    },
    detail: /token revoked/,
  },
  attester_no_write: {
    async run() {
      const s = await scene();
      await s.attest();
      world.github.setPermission(s.repo, s.user, "read");
      return s.ci();
    },
  },
  command_changed: {
    async run() {
      // main changes the suite's command after the branch left it; the developer's run reads the
      // command from the fetched main, and CI on a pull request of the branch into a release
      // branch (cut from the first main) builds the attested tree, whose first parent has the old one.
      const s = await scene();
      await s.fixture.git("branch", "release", "main");
      await s.fixture.push("release");
      await s.fixture.checkout("main");
      await s.fixture.commit("Change the test command", { "testnotary.json": `${JSON.stringify({ suites: { test: { command: [...MARKED.suites.test.command, "changed"] } } })}\n` });
      await s.fixture.push();
      await s.fixture.checkout("feature");
      await s.attest();
      await world.audits.forbid(s.repo);
      const merge = await s.fixture.testMerge({ base: "release", head: "feature" });
      const workspace = await s.fixture.ciCheckout(merge.sha);
      await installLibrary(workspace);
      const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });
      return { ...result, workspace, sha: merge.sha, repo: s.repo };
    },
  },
  guarded_file_changed: {
    async run() {
      const s = await scene();
      await s.fixture.commit("Pin Node", { ".nvmrc": "24\n" });
      await s.fixture.push();
      // The laptop runs the Node the new .nvmrc names, so the run itself passes the environment floor.
      await s.attest(undefined, { node: "v24.11.0", lts: "Krypton" });
      return s.ci();
    },
    detail: /\.nvmrc/,
  },
  signature_missing: {
    async run() {
      // No signing key on the laptop: the run attests unsigned (with a no_signing_key warning).
      const s = await scene({ config: SIGNED });
      await s.attest();
      return s.ci({ fetchDepth: 2 });
    },
  },
  signature_invalid: {
    async run() {
      // Signed with a key that is neither the developer's on GitHub nor in allowed_signers.
      const s = await scene({ config: SIGNED });
      await useSigningKey(s.fixture, await world.sshKey());
      await s.attest();
      return s.ci({ fetchDepth: 2 });
    },
  },
  github_unavailable: {
    async run() {
      // A trusted signature, but GitHub fails the action's own lookup of the signer.
      const s = await scene({ config: SIGNED });
      const key = await world.sshKey();
      world.github.addSigningKey(s.user, key.publicKey);
      await useSigningKey(s.fixture, key);
      await s.attest();
      return during(
        world.github.override("GET", "/user/:id", () => githubError(500, "Server Error"), { when: fromJob }),
        () => s.ci({ fetchDepth: 2 }),
      );
    },
  },
  audit: {
    async run() {
      const s = await scene();
      await s.attest();
      return s.ci({ audit: true });
    },
  },
};

/** A base config that requires signatures (signature mode), with the marked suite. */
const SIGNED = { signatures: "required", ...MARKED };

/** Makes `key` the developer's git signing key in the repo, as `git config gpg.format ssh` + `user.signingKey` do. */
async function useSigningKey(fixture: FixtureRepo, key: SshKeyPair): Promise<void> {
  await fixture.git("config", "gpg.format", "ssh");
  await fixture.git("config", "user.signingKey", key.privateKeyPath);
}

/** Runs `body` with an override in place, then removes it. */
async function during<T>(remove: () => void, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    remove();
  }
}

/** GitHub's 403 for an organization's IP allow list, on the service's commit lookups only. */
function denyByIpAllowList(repo: FakeRepo): () => void {
  return world.github.override(
    "GET",
    `/repos/${repo.owner}/${repo.name}/git/commits/:sha`,
    () => githubError(403, `Although you appear to have the correct authorization credentials, the \`${repo.owner}\` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.`),
    { when: (request) => !fromJob(request) },
  );
}

/** Calls that left the runner for the service or for an OIDC token, from here on. */
function callsFrom(): () => { service: number; tokens: number } {
  const service = world.service.requests.length;
  const tokens = world.github.requestsTo("GET", "/oidc/_request").length;
  return () => ({ service: world.service.requests.length - service, tokens: world.github.requestsTo("GET", "/oidc/_request").length - tokens });
}

/** The bold line of the job summary: the PR line. */
function line(summary: string): string {
  return summary.split("\n").find((text) => text.startsWith("**"))!.slice(2, -2);
}

describe("identity and GitHub", () => {
  test("token_rejected doesn't say which check failed; the service logs it", async () => {
    const s = await scene();
    await s.attest();
    const logs = world.service.logs.length;

    const result = await s.ci({ enterpriseSlug: "acme/extra" });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "token_rejected", ran: "true" });
    expect(line(result.summary)).toMatch(/^Fell back: token_rejected, the service did not accept the job's OIDC token · the tests passed in /);
    expect(result.summary).not.toMatch(/\biss\b|issuer|claim/);
    expect(world.service.logs.slice(logs)).toContainEqual(expect.objectContaining({ event: "token_rejected", reason: "claim_iss" }));
  });

  test("a job whose token comes from its enterprise's slug issuer verifies and skips", async () => {
    const s = await scene();
    await s.attest();

    const result = await s.ci({ enterpriseSlug: "octocat-inc" });

    expect(result.outputs).toMatchObject({ result: "skip", ran: "false" });
    // The verification stores the slug issuer, read back as a later step of the job would.
    const id = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    const token = await world.github.oidc.tokenFor(
      { repo: s.repo, sha: result.sha, ref: "refs/pull/1/merge", eventName: "pull_request", enterpriseSlug: "octocat-inc" },
      "https://testnotary.dev",
    );
    const read = await fetch(`${world.service.url}/api/v1/verifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await read.json()) as { verification: { iss: string } }).verification.iss).toBe(`${world.github.oidc.issuer}/octocat-inc`);
  });

  test("github_denied from an IP allow list says so in the line, passes GitHub's message and links Limits in v1", async () => {
    const s = await scene();
    await s.attest();
    world.clock.set(new Date());

    const result = await during(denyByIpAllowList(s.repo), () => s.ci()).finally(() => world.clock.reset());

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "github_denied", ran: "true" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check!.output.title).toMatch(/^Fell back: github_denied \(an IP allow list blocks the service\), GitHub refused the service's request · the tests passed in /);
    expect(check!.output.summary).toContain(`the \\\`${s.repo.owner}\\\` organization has an IP allow list enabled`);
    expect(check!.output.summary).toContain("[Limits in v1](https://testnotary.dev/docs/limits#github-enterprise)");
    expect(result.summary).toContain(check!.output.title);
    expect(result.summary).toContain("[Limits in v1](https://testnotary.dev/docs/limits#github-enterprise)");
    // The service recorded it, so the dashboard counts it among the reasons jobs ran.
    expect(result.summary).toMatch(/- Verification: `[0-9a-f-]{36}`/);
  });

  test("github_denied for another reason names no allow list and passes no message", async () => {
    const s = await scene();
    await s.attest();
    world.clock.set(new Date());
    const deny = world.github.override(
      "GET",
      `/repos/${s.repo.owner}/${s.repo.name}/git/commits/:sha`,
      () => githubError(403, "Resource not accessible by integration"),
      { when: (request) => !fromJob(request) },
    );

    const result = await during(deny, () => s.ci()).finally(() => world.clock.reset());

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "github_denied", ran: "true" });
    expect(line(result.summary)).toMatch(/^Fell back: github_denied, GitHub refused the service's request · /);
    expect(result.summary).not.toMatch(/Resource not accessible|Limits in v1/);
    expect(result.summary).toMatch(/- Verification: `[0-9a-f-]{36}`/);
  });

  test("repo_not_installed: the App isn't on the repo, and the tests run", async () => {
    const s = await scene({ install: false });

    const result = await s.ci();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "repo_not_installed", ran: "true" });
    expect(line(result.summary)).toMatch(/^Fell back: repo_not_installed, the Testnotary GitHub App is not installed on this repo · /);
  });
});

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

  test("a Dependabot pull request gets an OIDC token, unlike a fork's: it verifies, and its check run is made", async () => {
    const s = await scene();
    const from = world.service.requests.length;

    const result = await s.ci({ dependabot: true });

    // Nobody attested Dependabot's tree, so the service answers no_attestation: but it answered.
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(result.summary).toMatch(/- Verification: `[0-9a-f-]{36}`/);
    expect(result.stdout).not.toMatch(/::(notice|warning)::/);
    const [verify] = world.service.requests.slice(from).filter((request) => request.method === "POST" && request.path === "/api/v1/verifications");
    const claims = JSON.parse(Buffer.from(verify!.headers.authorization!.split(".")[1]!, "base64url").toString()) as { actor: string };
    expect(claims.actor).toBe("dependabot[bot]");
    expect(world.github.checkRuns(s.repo)).toEqual([expect.objectContaining({ conclusion: "neutral" })]);
  });
});

describe("every fallback reason code runs the tests and names the code", () => {
  test.each(FALLBACK_REASONS.map((code) => [code, CASES[code]] as const))("%s", async (code, { run, detail }) => {
    // The world clock stands still, so a retry's pause or a stalled service takes no real time.
    world.clock.set(new Date());
    let result: Awaited<ReturnType<Case["run"]>>;
    try {
      result = await run();
    } finally {
      world.clock.reset();
    }

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.workspace, "ran.txt"))).toBe(true);
    const audit = code === "audit";
    expect(result.outputs).toMatchObject({ result: audit ? "audit" : "fallback", reason: code, ran: "true" });
    const title = line(result.summary);
    if (audit) expect(title).toMatch(/^Audit · /);
    // The code, its detail in brackets (the case's when it names one), then the words for the code.
    else expect(title).toMatch(new RegExp(`^Fell back: ${code}${detail ? ` \\(.*${detail.source}.*\\)` : "(?: \\(.+\\))?"}, [^·]+ · the tests passed in `));
    expect(world.github.checkRuns(result.repo).at(-1)).toMatchObject({ conclusion: audit ? "success" : "neutral", output: { title } });
  });
});

describe("a reason code this action doesn't know", () => {
  // Adding a code is a minor version, so an action pinned to an older release meets codes from the
  // always-current service that it has no words for. A service answering with one stands in here.
  test.each([
    { answered: "fallback", reason: "future_code", detail: null },
    { answered: "fallback", reason: "future_code", detail: "what it names" },
    { answered: "skip", reason: "future_code", detail: null },
  ] as const)("$reason on a $answered (detail $detail) falls back with the code itself and runs the tests", async ({ answered, reason, detail }) => {
    const s = await scene();
    await s.attest();
    const service = await world.compromisedService<Record<string, unknown>>((honest) => ({ ...honest, result: answered, reason, detail }));

    const result = await s.ci({ env: { TESTNOTARY_URL: service } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.workspace, "ran.txt"))).toBe(true);
    expect(result.outputs).toMatchObject({ result: "fallback", reason, ran: "true" });
    const title = line(result.summary);
    expect(title).toMatch(new RegExp(`^Fell back: ${reason}${detail ? ` \\(${detail}\\)` : ""} · the tests passed in `));
    expect(title).not.toContain("undefined");
    expect(world.github.checkRuns(result.repo).at(-1)).toMatchObject({ conclusion: "neutral", output: { title } });
  });
});

test("the table has a case for each of the 20 codes, which core exports as one list", () => {
  expect(FALLBACK_REASONS).toHaveLength(20);
  expect(new Set(FALLBACK_REASONS).size).toBe(20);
  expect(Object.keys(CASES).sort()).toEqual([...FALLBACK_REASONS].sort());
});
