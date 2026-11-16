import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Verification } from "@testnotary/protocol";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The audit draw: in enforce mode CI runs the tests anyway on a random share of the trees an
// attestation covers, HMAC(per-repo key, tree + suite) against the rate. The world's audit master
// key is fixed, so a tree is drawn or not, every time; a test finds trees of each kind.

const world = useWorld();

const SUITE = "test";
/**
 * Leaves `ran.txt`, so a test sees whether the command ran, and fails (exit 1) where a file named
 * `fails-here` exists: a test drops it in CI's workspace to make CI disagree with the laptop. Where
 * `slow-here` exists it takes 4 s, so a test can cancel the job while the tests run.
 */
const SCRIPT = [
  "const fs = require('fs');",
  "fs.writeFileSync('ran.txt', 'x');",
  "if (fs.existsSync('slow-here')) setTimeout(() => process.exit(1), 4000);",
  "else process.exit(fs.existsSync('fails-here') ? 1 : 0);",
].join(" ");
const PASSING = { suites: { [SUITE]: { command: ["node", "-e", SCRIPT] } } };
/** A command only the laptop has (`check.sh` is ignored by git): `exec` in CI refuses it, `command_not_found`. */
const LAPTOP_ONLY = { suites: { [SUITE]: { command: ["./check.sh"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` on the developer's laptop; must attest. */
  attest(): Promise<void>;
  /** The action in a gate job (`mode: verify`) on a commit. */
  gate(sha: string, options?: { event?: string; ref?: string }): ReturnType<typeof world.runAction>;
  /**
   * The action's run-mode step on a commit, in a fresh checkout with the library installed. With
   * `fails`, the tests fail in CI although they passed on the laptop.
   */
  ci(sha: string, options?: CiOptions): Promise<Awaited<ReturnType<typeof world.runAction>> & { workspace: string }>;
}

interface CiOptions {
  /** The tests fail in CI although they passed on the laptop. */
  fails?: boolean;
  /** The job is cancelled while its tests run. */
  cancelled?: boolean;
  event?: string;
  ref?: string;
}

let repos = 0;

/** An installed repo (in enforce mode at the default rates, unless `mode` says shadow), and a developer with write access signed in on their laptop. */
async function story(options: { mode?: "shadow" | "enforce"; config?: Record<string, unknown> } = {}): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({
    config: options.config ?? PASSING,
    files: {
      "package.json": '{ "name": "widgets", "private": true, "packageManager": "pnpm@10.34.9" }\n',
      ".gitignore": "node_modules\nran.txt\nfails-here\nslow-here\ncheck.sh\n",
    },
  });
  await writeFile(join(fixture.dir, "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const repo = await world.hostOnGitHub(fixture, { owner: `audit-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `audit-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `audit-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  if ((options.mode ?? "enforce") === "enforce") await setMode(repo, "enforce");
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
    gate: (sha, { event, ref } = {}) => world.runAction({ repo, sha, event, ref, workspace: fixture.dir, inputs: { suite: SUITE, mode: "verify" } }),
    async ci(sha, { fails = false, cancelled = false, event, ref } = {}) {
      const workspace = await fixture.ciCheckout(sha);
      await installLibrary(workspace);
      if (fails) await writeFile(join(workspace, "fails-here"), "");
      if (cancelled) await writeFile(join(workspace, "slow-here"), "");
      const cancelOnceExists = cancelled ? join(workspace, "ran.txt") : undefined;
      return { ...(await world.runAction({ repo, sha, event, ref, workspace, inputs: { suite: SUITE }, cancelOnceExists })), workspace };
    },
  };
}

/** What a later step of the same repo's CI reads back about a verification, with its own fresh OIDC token. */
async function readBack(repo: FakeRepo, sha: string, id: string): Promise<Verification> {
  const token = await world.github.oidc.tokenFor({ repo, sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const response = await fetch(`${world.service.url}/api/v1/verifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { verification: Verification }).verification;
}

/** Enforce mode, with these rates, as a repo admin's Settings change does. */
async function setMode(repo: FakeRepo, mode: "enforce", rates: { auditOneIn?: number; sandboxAuditOneIn?: number } = {}) {
  await world.enforce(repo, rates);
}

/**
 * A feature branch whose one commit has a tree the draw treats as `wanted` says, found by trying
 * one small file after another (no key version is touched), pushed. Returns the tree.
 */
async function featureWithTree(s: Story, wanted: (tree: string) => Promise<boolean>, branch = "feature"): Promise<string> {
  await s.fixture.checkout("main");
  await s.fixture.branch(branch);
  for (let attempt = 0; attempt < 500; attempt++) {
    await s.fixture.write({ [`src/${branch}.js`]: `export const a = ${attempt};\n` });
    await s.fixture.git("add", "--all");
    const tree = (await s.fixture.git("write-tree")).trim();
    if (await wanted(tree)) {
      await s.fixture.commit(`Change ${branch}`);
      await s.fixture.push();
      return tree;
    }
  }
  throw new Error("no tree of the kind wanted in 500 attempts");
}

const drawnAt = (s: Story, tokenKind: "laptop" | "sandbox") => (tree: string) => world.audits.drawn(s.repo, { tree, suite: SUITE, tokenKind });

/** A pull request whose tree the draw picks at 1 in 10 (or doesn't, with `drawn: false`), attested on the laptop, and its test merge commit. */
async function attestedPullRequest(s: Story, { drawn = true, branch = "feature", number = 1 } = {}) {
  await featureWithTree(s, async (tree) => (drawn ? drawnAt(s, "laptop")(tree) : !(await drawnAt(s, "sandbox")(tree))), branch);
  await s.attest();
  return s.fixture.testMerge({ base: "main", head: branch, number });
}

const auditedPullRequest = (s: Story) => attestedPullRequest(s);

describe("the audit draw, under the world's fixed master key", () => {
  test("at 1 in 10, a tree the draw picks reads audit, every time, and a tree it doesn't pick skips", async () => {
    const drawn = await story();
    const tree = await featureWithTree(drawn, drawnAt(drawn, "laptop"));
    await drawn.attest();
    const merge = await drawn.fixture.testMerge({ base: "main", head: "feature" });
    expect(merge.tree).toBe(tree);

    const first = await drawn.gate(merge.sha);
    const again = await drawn.gate(merge.sha);

    expect(first.outputs).toMatchObject({ result: "audit", reason: "audit", skip: "false", ran: "false" });
    expect(again.outputs).toMatchObject({ result: "audit", skip: "false" });

    const skipped = await story();
    await featureWithTree(skipped, async (candidate) => !(await drawnAt(skipped, "sandbox")(candidate)));
    await skipped.attest();
    const other = await skipped.fixture.testMerge({ base: "main", head: "feature" });

    expect((await skipped.gate(other.sha)).outputs).toMatchObject({ result: "skip", skip: "true" });
  });

  test("at 1 in 5 for a sandbox token: a tree drawn at 1 in 5 but not at 1 in 10 skips on a laptop token and is audited on a sandbox token", async () => {
    const s = await story();
    await featureWithTree(s, async (tree) => (await drawnAt(s, "sandbox")(tree)) && !(await drawnAt(s, "laptop")(tree)));
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "skip" });

    // An agent attests the same tree with a sandbox token: the newest attestation is matched.
    const token = await world.sandboxToken({ creator: s.user, repo: s.repo, name: "agent" });
    const sandbox = await world.machine();
    const run = await world.runCli(["run"], { cwd: s.fixture.dir, machine: sandbox, env: { TESTNOTARY_SANDBOX: "1", TESTNOTARY_TOKEN: token } });
    expect(run.stderr).toMatch(/attested=true/);

    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "audit", reason: "audit" });
  });
});

describe("an audited job", () => {
  test("runs the tests, outputs audit, and has its own line; when they pass the check succeeds and the repo stays in enforce", async () => {
    const s = await story();
    const merge = await auditedPullRequest(s);

    const result = await s.ci(merge.sha);

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ result: "audit", reason: "audit", ran: "true" });
    expect(existsSync(join(result.workspace, "ran.txt"))).toBe(true);
    const [check, ...more] = world.github.checkRuns(s.repo);
    expect(more).toEqual([]);
    expect(check).toMatchObject({ name: "Testnotary / test", conclusion: "success" });
    expect(check!.output.title).toMatch(new RegExp(`^Audit · test passed .+ ago · attested by @${s.user.login} · laptop token "[^"]+" · .+ · the tests passed in [\\d.]+ s$`));
    expect(result.summary).toContain(check!.output.title);
    const read = await readBack(s.repo, merge.sha, (await s.gate(merge.sha)).outputs.verification!);
    expect(read).toMatchObject({ mode: "enforce", result: "audit", mismatch: null });
  });

  test("whose tests fail: the step fails, the check fails with the mismatch line, a mismatch is recorded and the repo returns to shadow mode", async () => {
    const s = await story();
    const merge = await auditedPullRequest(s);

    const result = await s.ci(merge.sha, { fails: true });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual({ result: "audit", reason: "audit", ran: "true" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ conclusion: "failure" });
    expect(check!.output.title).toMatch(
      new RegExp(`^Mismatch: the audit failed · test passed .+ ago · attested by @${s.user.login} · laptop token "[^"]+" · .+ · the tests failed in [\\d.]+ s \\(exit code 1\\) · the repo is back in shadow mode$`),
    );
    expect(result.summary).toContain(check!.output.title);
    expect(result.summary).toContain(`${world.service.url}/${s.repo.fullName}/mismatches`);

    // Back in shadow mode at once: the same tree would skip now, and doesn't.
    const next = await s.gate(merge.sha);
    expect(next.outputs).toMatchObject({ result: "would_skip", skip: "false" });
  });
});

describe("an audit that fails after merge", () => {
  test("on the default branch's push: the run stays red with the mismatch line in its summary, a mismatch is recorded, the repo returns to shadow, and nothing is commented or reverted", async () => {
    const s = await story();
    await featureWithTree(s, drawnAt(s, "laptop"));
    await s.attest();
    await s.fixture.checkout("main");
    await s.fixture.git("merge", "--quiet", "--no-ff", "--no-edit", "feature");
    await s.fixture.push("main");
    const head = await s.fixture.revParse("main");
    const githubFrom = world.github.requests.length;

    const result = await s.ci(head, { fails: true, event: "push", ref: "refs/heads/main" });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual({ result: "audit", reason: "audit", ran: "true" });
    expect(result.summary).toMatch(/\*\*Mismatch: the audit failed · .+ · the repo is back in shadow mode\*\*/);
    expect(result.summary).toContain("- Mismatch: recorded against");
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ headSha: head, conclusion: "failure" });
    // Besides reads and tokens, the only call to GitHub is the check run: no comment on the merged
    // pull request, and no push or ref change that would revert it.
    const writes = world.github.requests
      .slice(githubFrom)
      .filter((request) => request.method !== "GET" && !request.path.includes("/oidc") && !request.path.endsWith("/access_tokens"))
      .map((request) => `${request.method} ${request.path}`);
    expect(writes).toEqual([`POST /repos/${s.repo.fullName}/check-runs`]);
    expect(await s.fixture.git("ls-remote", "origin", "refs/heads/main")).toContain(head);

    const verificationId = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    const token = await world.github.oidc.tokenFor({ repo: s.repo, sha: head, ref: "refs/heads/main", eventName: "push" }, "https://testnotary.dev");
    const read = await fetch(`${world.service.url}/api/v1/verifications/${verificationId}`, { headers: { authorization: `Bearer ${token}` } });
    const { verification } = (await read.json()) as { verification: Verification };
    expect(verification.mismatch).toMatchObject({ result: "audit", commit: head, event: "push" });
    expect((await s.gate(head, { event: "push", ref: "refs/heads/main" })).outputs.result).toBe("would_skip");
  });
});

describe("a mismatch is self-contained", () => {
  test("it copies the account, token, payload, both environments and the commits skipped since the account's last agreeing audit, and outlives the rows it came from", async () => {
    const s = await story();
    // Skipped before the account's last agreeing audit: not listed.
    const early = await attestedPullRequest(s, { drawn: false, branch: "early", number: 1 });
    expect((await s.gate(early.sha)).outputs.result).toBe("skip");
    // An audit that agrees.
    const agreeing = await attestedPullRequest(s, { branch: "agreeing", number: 2 });
    expect((await s.ci(agreeing.sha)).outputs.result).toBe("audit");
    // Skipped since: listed, once, though verified twice.
    const later = await attestedPullRequest(s, { drawn: false, branch: "later", number: 3 });
    expect((await s.gate(later.sha)).outputs.result).toBe("skip");
    expect((await s.gate(later.sha)).outputs.result).toBe("skip");
    // The audit that fails.
    const failing = await attestedPullRequest(s, { branch: "failing", number: 4 });
    const result = await s.ci(failing.sha, { fails: true });
    expect(result.outputs.result).toBe("audit");

    const verificationId = /- Verification: `([0-9a-f-]{36})`/.exec(result.summary)![1]!;
    const recorded = await readBack(s.repo, failing.sha, verificationId);
    const mismatch = recorded.mismatch!;
    expect(mismatch).toMatchObject({
      result: "audit",
      suite: SUITE,
      commit: failing.sha,
      tree: failing.tree,
      event: "pull_request",
      account: { id: s.user.id, login: s.user.login },
      token: { kind: "laptop", name: recorded.attestation!.attester.token.name },
      attestation: { id: recorded.attestation!.id, runId: recorded.attestation!.run.id, commit: failing.parents[1], format: "testnotary.attestation/v1", signature: null },
      environments: { run: recorded.attestation!.run.environment, ci: { os: "Linux", arch: "X64", image: null, imageVersion: null } },
      tests: { outcome: "failed" },
    });
    expect(mismatch.attestation.payload).toBe(recorded.attestation!.payload);
    expect(mismatch.environments.run).toMatchObject({ os: process.platform, arch: process.arch });
    expect(mismatch.skippedCommits.map((skipped) => skipped.commit)).toEqual([later.sha]);
    expect(mismatch.skippedCommits[0]).toMatchObject({ tree: later.tree, suite: SUITE, event: "pull_request" });

    // Retention prunes the rows the mismatch came from (at 90 days); nothing in the mismatch row
    // points at them, so it stays, with its copies.
    const retention = world.db.connect("retention");
    await retention`delete from job_reports where verification_id in (select id from verifications where repo_id = ${s.repo.id})`;
    await retention`delete from verifications where repo_id = ${s.repo.id}`;
    await retention`delete from attestations where repo_id = ${s.repo.id}`;
    await retention`delete from runs where repo_id = ${s.repo.id}`;
    const [kept] = await retention<{ payload: Buffer; ciEnvironment: unknown; skippedCommits: unknown[]; accountId: number; tokenKind: string }[]>`
      select attestation_payload as payload, ci_environment as "ciEnvironment", skipped_commits as "skippedCommits", account_id::int as "accountId", token_kind as "tokenKind"
      from mismatches where id = ${mismatch.id}`;
    expect(kept!.payload.toString("utf8")).toBe(mismatch.attestation.payload);
    expect(kept).toMatchObject({ ciEnvironment: mismatch.environments.ci, skippedCommits: mismatch.skippedCommits, accountId: s.user.id, tokenKind: "laptop" });
  });
});

describe("in shadow mode", () => {
  test("no audit is drawn: a tree the draw would pick reads would_skip", async () => {
    const s = await story({ mode: "shadow" });
    const merge = await auditedPullRequest(s);

    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "would_skip", reason: "" });
  });

  test("a failing report on a would-skip creates a mismatch, with its own line and a failing check", async () => {
    const s = await story({ mode: "shadow" });
    const merge = await attestedPullRequest(s, { drawn: false });

    const result = await s.ci(merge.sha, { fails: true });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual({ result: "would_skip", reason: "", ran: "true" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ conclusion: "failure" });
    expect(check!.output.title).toMatch(
      new RegExp(`^Mismatch: would have skipped · test passed .+ ago · attested by @${s.user.login} · .+ · shadow mode: the tests failed in [\\d.]+ s \\(exit code 1\\)$`),
    );
    expect(result.summary).toMatch(/- Mismatch: recorded against @audit-dev-\d+ and laptop token "[^"]+"\. Nothing was revoked\./);
    const gate = await s.gate(merge.sha);
    expect((await readBack(s.repo, merge.sha, gate.outputs.verification!)).mode).toBe("shadow");
  });
});

describe("what is neither an agreement nor a mismatch", () => {
  test("a cancelled audit job: no report, no mismatch, and the repo stays in enforce", async () => {
    const s = await story();
    const merge = await auditedPullRequest(s);
    const from = world.service.requests.length;

    const result = await s.ci(merge.sha, { cancelled: true });

    expect(result.signal).toBe("SIGTERM");
    expect(world.service.requests.slice(from).map((request) => `${request.method} ${request.path}`)).toEqual(["POST /api/v1/verifications"]);
    const gate = await s.gate(merge.sha);
    expect(gate.outputs.result).toBe("audit");
    const read = await readBack(s.repo, merge.sha, gate.outputs.verification!);
    expect(read).toMatchObject({ mode: "enforce", jobReport: null, mismatch: null });
  });

  test("an audit whose tests exec refused to start: the report says refused, no mismatch, and the repo stays in enforce", async () => {
    const s = await story({ config: LAPTOP_ONLY });
    const merge = await auditedPullRequest(s);

    const result = await s.ci(merge.sha);

    expect(result.outputs).toMatchObject({ result: "audit", ran: "true" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ conclusion: "neutral" });
    expect(check!.output.title).toMatch(/^Audit · .+ · exec refused to start the tests \(exit code 2\)$/);
    const gate = await s.gate(merge.sha);
    expect(gate.outputs.result).toBe("audit");
  });

  test("a fallback whose tests fail is an ordinary failure: no mismatch, a neutral check, and the repo stays in enforce", async () => {
    const s = await story();
    await featureWithTree(s, async () => true);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.ci(merge.sha, { fails: true });

    expect(result.exitCode).toBe(1);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation" });
    expect(world.github.checkRuns(s.repo)[0]).toMatchObject({ conclusion: "neutral" });
    expect((await s.gate(merge.sha)).outputs.result).toBe("fallback");
  });
});

describe("rotating the audit key", () => {
  /** The operations script (`apps/web/scripts/ops.ts`) as the operator runs it, as the app role. */
  function ops(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const script = fileURLToPath(new URL("../../../apps/web/scripts/ops.ts", import.meta.url));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
        env: { PATH: process.env.PATH, DATABASE_URL: world.db.urls.app },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  test("for one repo changes its draws and leaves other repos' alone", async () => {
    const rotated = await story();
    await featureWithTree(rotated, async (tree) => {
      const drawn = (keyVersion: number) => world.audits.drawn(rotated.repo, { tree, suite: SUITE, tokenKind: "laptop", keyVersion });
      return (await drawn(1)) && !(await drawn(2));
    });
    await rotated.attest();
    const first = await rotated.fixture.testMerge({ base: "main", head: "feature" });
    const other = await story();
    const second = await auditedPullRequest(other);
    expect((await rotated.gate(first.sha)).outputs.result).toBe("audit");
    expect((await other.gate(second.sha)).outputs.result).toBe("audit");

    const result = await ops(["rotate-audit-key", rotated.repo.fullName, "--reason", "key exposure drill"]);

    expect(result).toMatchObject({ code: 0, stdout: `rotated the audit key of ${rotated.repo.fullName} to version 2\n` });
    expect((await rotated.gate(first.sha)).outputs.result).toBe("skip");
    expect((await other.gate(second.sha)).outputs.result).toBe("audit");
  });

  test("for every repo raises each one's version", async () => {
    const s = await story();
    const before = await world.audits.keyVersion(s.repo);

    const result = await ops(["rotate-audit-key", "--all", "--reason", "yearly rotation"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^rotated the audit keys of \d+ repos\n$/);
    expect(await world.audits.keyVersion(s.repo)).toBe(before + 1);
  });

  test("needs a reason and a repo Testnotary knows", async () => {
    expect(await ops(["rotate-audit-key", "nobody/nothing", "--reason", "drill"])).toMatchObject({ code: 1, stderr: "ops: no repo named nobody/nothing\n" });
    expect((await ops(["rotate-audit-key", "--all"])).code).toBe(2);
  });
});

describe("audit rates", () => {
  test("can be raised: at 1 in 1 every tree is audited, on any token", async () => {
    const s = await story();
    await featureWithTree(s, async (tree) => !(await drawnAt(s, "sandbox")(tree)));
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "skip" });

    await setMode(s.repo, "enforce", { auditOneIn: 1, sandboxAuditOneIn: 1 });

    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "audit" });
  });

  test.each([
    { auditOneIn: 11, sandboxAuditOneIn: 5 },
    { auditOneIn: 20, sandboxAuditOneIn: 5 },
    { auditOneIn: 10, sandboxAuditOneIn: 6 },
    { auditOneIn: 0, sandboxAuditOneIn: 5 },
  ])("a setting below the defaults is refused: 1 in $auditOneIn, sandbox 1 in $sandboxAuditOneIn", async (rates) => {
    const s = await story();

    const admin = world.github.addUser({ login: `rates-admin-${s.repo.id}` });
    world.github.setPermission(s.repo, admin, "admin");

    const change = await world.changeRepoSettings({ admin, repo: s.repo, mode: "enforce", ...rates });

    expect(change).toMatchObject({ ok: false, problem: expect.stringMatching(/1 in (10|5)/) as string });
    // Nothing changed: the rates are still the defaults.
    expect(await world.changeRepoSettings({ admin, repo: s.repo })).toMatchObject({ ok: true, settings: { auditOneIn: 10, sandboxAuditOneIn: 5 } });
  });
});
