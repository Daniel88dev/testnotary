import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The gate job: the action in `mode: verify` asks the service whether an attestation names the
// tree CI builds, and answers with `skip` and `verification`. Each story starts on a laptop that
// attests with `testnotary run`, as a repo meets the product.

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run <args>` in the fixture repo, on the developer's laptop; must attest. */
  attest(args?: string[]): Promise<void>;
  /** The action in a gate job: `mode: verify`, on a simulated runner. */
  gate(options: { sha: string; event?: string; suite?: string }): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed repo, and a developer with write access signed in on their laptop. */
async function story(options: { config?: Record<string, unknown> } = {}): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config ?? PASSING });
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
    async attest(args = []) {
      const result = await world.runCli(["run", ...args], { cwd: fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
    gate: ({ sha, event, suite }) =>
      world.runAction({ repo, sha, event, workspace: fixture.dir, inputs: { suite: suite ?? "test", mode: "verify" } }),
  };
}

/** A second developer with write access, signed in on their own laptop, in the same clone. */
async function colleague(s: Story): Promise<{ user: FakeAccount; attest(): Promise<void> }> {
  const user = world.github.addUser({ login: `colleague-${++repos}` });
  world.github.setPermission(s.repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    user,
    async attest() {
      const result = await world.runCli(["run"], { cwd: s.fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
    },
  };
}

/** The account a recorded verification's matched attestation names, from its payload. */
function attesterOf(verification: Record<string, unknown>): number {
  const { payload } = verification.attestation as { payload: string };
  return (JSON.parse(payload) as { attester: { account: number } }).attester.account;
}

/** A feature branch with one change, pushed, so a pull request can be opened from it. */
async function featureBranch(s: Story, files: Record<string, string> = { "src/a.js": "export const a = 1;\n" }) {
  await s.fixture.branch("feature");
  await s.fixture.commit("Add a", files);
  await s.fixture.push();
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

describe("the gate job", () => {
  test("a pull_request merge commit with the tree a laptop attested skips in enforce mode", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);

    const result = await s.gate({ sha: merge.sha });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", skip: "true", ran: "false", reason: "" });
    expect(result.outputs.verification).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("the same pull request in shadow mode would skip, and does not skip", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.gate({ sha: merge.sha });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "would_skip", skip: "false", reason: "" });
    expect(result.outputs.verification).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the verification output", () => {
  /** What a later step of the same repo's CI reads back with its own fresh OIDC token. */
  async function readBack(repo: FakeRepo, sha: string, id: string) {
    const token = await world.github.oidc.tokenFor({ repo, sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
    const response = await fetch(`${world.service.url}/api/v1/verifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as { verification?: Record<string, unknown> } };
  }

  test("carries the id a later test step reads the recorded verification by", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);

    const gate = await s.gate({ sha: merge.sha });
    const read = await readBack(s.repo, merge.sha, gate.outputs.verification!);

    expect(read.status).toBe(200);
    expect(read.body.verification).toMatchObject({
      id: gate.outputs.verification,
      repository: { id: s.repo.id, fullName: s.repo.fullName },
      suite: "test",
      commit: merge.sha,
      tree: merge.tree,
      event: "pull_request",
      iss: world.github.oidc.issuer,
      mode: "enforce",
      result: "skip",
      reason: null,
      attestation: { id: expect.any(String) as string, format: "testnotary.attestation/v1" },
    });
    const payload = JSON.parse((read.body.verification!.attestation as { payload: string }).payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ repository: s.repo.id, suite: "test", tree: merge.tree, outcome: "passed" });
  });

  test("records the attestation it matched also when it then falls back", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    world.github.setPermission(s.repo, s.user, "read");

    const gate = await s.gate({ sha: merge.sha });
    const read = await readBack(s.repo, merge.sha, gate.outputs.verification!);

    expect(read.body.verification).toMatchObject({ mode: "shadow", result: "would_fall_back", reason: "attester_no_write", attestation: { format: "testnotary.attestation/v1" } });
  });

  test("an older attestation of the tree still skips when the newest one's attester lost write access, and is the one recorded", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const later = await colleague(s);
    await later.attest();
    world.github.setPermission(s.repo, later.user, "read");
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);

    const gate = await s.gate({ sha: merge.sha });
    const read = await readBack(s.repo, merge.sha, gate.outputs.verification!);

    expect(gate.outputs).toMatchObject({ result: "skip", skip: "true", reason: "" });
    expect(read.body.verification).toMatchObject({ result: "skip", reason: null });
    expect(attesterOf(read.body.verification!)).toBe(s.user.id);
  });

  test("when no attestation of the tree clears, the newest one's reason is given and the newest one recorded", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const later = await colleague(s);
    await later.attest();
    world.github.setPermission(s.repo, s.user, "read");
    world.github.setPermission(s.repo, later.user, "none");
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const gate = await s.gate({ sha: merge.sha });
    const read = await readBack(s.repo, merge.sha, gate.outputs.verification!);

    expect(gate.outputs).toMatchObject({ result: "would_fall_back", reason: "attester_no_write" });
    expect(attesterOf(read.body.verification!)).toBe(later.user.id);
  });

  test("is no use to another repo's CI", async () => {
    const s = await story();
    await featureBranch(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const other = await story();
    await featureBranch(other);
    const otherMerge = await other.fixture.testMerge({ base: "main", head: "feature" });

    const gate = await s.gate({ sha: merge.sha });
    const read = await readBack(other.repo, otherMerge.sha, gate.outputs.verification!);

    expect(read.status).toBe(404);
  });

  test("works on a runner with no checkout: the gate job needs only the action", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const empty = await world.machine();

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: empty.home, inputs: { suite: "test", mode: "verify" } });

    expect(result.outputs).toMatchObject({ result: "would_skip", skip: "false" });
  });

  test("names the config's only suite when the job leaves suite out", async () => {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace: s.fixture.dir, inputs: { mode: "verify" } });

    expect(result.outputs).toMatchObject({ result: "would_skip" });
  });

  test("sends the token, the suite and the runner's environment, and never a SHA, tree or path", async () => {
    const s = await story();
    await featureBranch(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    const from = world.service.requests.length;

    await s.gate({ sha: merge.sha });

    const [sent] = world.service.requests.slice(from).filter((r) => r.method === "POST" && r.path === "/api/v1/verifications");
    expect(sent!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const body = JSON.parse(sent!.text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["environment", "suite"]);
    expect(body.suite).toBe("test");
    expect(body.environment).toEqual({ os: "Linux", arch: "X64", image: null, imageVersion: null, node: expect.stringMatching(/^v\d+/) as string });
    expect(sent!.text).not.toContain(merge.sha);
    expect(sent!.text).not.toContain(merge.tree);
  });
});

describe("the gate job falls back", () => {
  /** An attested pull request in enforce mode, and its test merge commit. */
  async function attestedPullRequest() {
    const s = await story();
    await featureBranch(s);
    await s.attest();
    await enforce(s.repo);
    return { s, merge: await s.fixture.testMerge({ base: "main", head: "feature" }) };
  }

  test("when no attestation names the tree CI builds: no_attestation", async () => {
    const { s } = await attestedPullRequest();
    await s.fixture.commit("Change a again", { "src/a.js": "export const a = 2;\n" });
    await s.fixture.push();
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.gate({ sha: merge.sha });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", skip: "false" });
    expect(result.outputs.verification).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("when the base config declares no such suite: unknown_suite", async () => {
    const { s, merge } = await attestedPullRequest();

    const result = await s.gate({ sha: merge.sha, suite: "e2e" });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "unknown_suite", skip: "false" });
  });

  test("when the attestation's run ended 24 h ago or more: attestation_expired", async () => {
    const { s, merge } = await attestedPullRequest();
    try {
      world.clock.advance(24 * 3_600_000 - 60_000);
      const young = await s.gate({ sha: merge.sha });
      world.clock.advance(60_000);
      const old = await s.gate({ sha: merge.sha });

      expect(young.outputs).toMatchObject({ result: "skip", skip: "true" });
      expect(old.outputs).toMatchObject({ result: "fallback", reason: "attestation_expired", skip: "false" });
    } finally {
      world.clock.reset();
    }
  });

  test.each(["read", "triage", "none"] as const)("when the attester now has only %s: attester_no_write", async (permission) => {
    const { s, merge } = await attestedPullRequest();
    world.github.setPermission(s.repo, s.user, permission);

    const result = await s.gate({ sha: merge.sha });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attester_no_write", skip: "false" });
  });

  test("an attester with maintain still counts as write", async () => {
    const { s, merge } = await attestedPullRequest();
    world.github.setPermission(s.repo, s.user, "maintain");

    const result = await s.gate({ sha: merge.sha });

    expect(result.outputs).toMatchObject({ result: "skip", skip: "true" });
  });

  test("when only the pull request's own config declares the suite: unknown_suite", async () => {
    const s = await story();
    const config = { suites: { ...PASSING.suites, e2e: { command: ["node", "-e", "process.exit(0)"] } } };
    await featureBranch(s, { "testnotary.json": `${JSON.stringify(config)}\n` });
    await enforce(s.repo);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.gate({ sha: merge.sha, suite: "e2e" });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "unknown_suite", skip: "false" });
  });

  test("in shadow mode a fallback reads would_fall_back", async () => {
    const s = await story();
    await featureBranch(s);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });

    const result = await s.gate({ sha: merge.sha });

    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation", skip: "false" });
  });
});
