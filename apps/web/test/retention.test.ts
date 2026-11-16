import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The retention job, as its schedule runs it: under the retention role, at the service clock's
// time. Runs, attestations, verifications and job reports go at 90 days; mismatches stay while the
// repo is installed; spent tokens go 90 days on when nothing kept points at them; a deleted
// account's login goes at once and its row once nothing names it. What it leaves is read back the
// way clients meet it (the API), and what it removes is looked for in every table.

const world = useWorld();

const DAY_MS = 86_400_000;
const AUDIENCE = "https://testnotary.dev";
const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
const RUN_ENVIRONMENT = { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" };
let n = 0;

interface Pull {
  number: number;
  sha: string;
  tree: string;
}

interface History {
  user: FakeAccount;
  repo: FakeRepo;
  fixture: FixtureRepo;
  machine: Machine;
  token: string;
  tokenId: string;
  /** `testnotary logout` on the laptop: revokes the token. */
  logout(): Promise<void>;
  /** A pull request off main with one change; returns GitHub's test merge commit and its tree. */
  pull(): Promise<Pull>;
  /** The developer's passed run on the pull request's tree, uploaded at the world clock's time. */
  attest(pull: Pull): Promise<{ runId: string; attestationId: string }>;
  /** CI's verification of the pull request's merge commit; returns its id and result. */
  verify(pull: Pull): Promise<{ id: string; result: string }>;
  report(pull: Pull, verification: string, outcome: "passed" | "failed"): Promise<{ mismatch: { id: string } | null }>;
  /** A run of the developer's, read back with their laptop token: its status. */
  readRun(runId: string): Promise<number>;
  /** A verification, read back by the repo's CI: its status. */
  readVerification(pull: Pull, id: string): Promise<number>;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${world.service.url}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** An installed public repo (shadow mode) and a developer with write access, signed in on a laptop. */
async function history(): Promise<History> {
  const i = ++n;
  const user = world.github.addUser({ login: `keep-dev-${i}` });
  const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: `keep-org-${i}`, name: "ledger", visibility: "public" });
  await world.github.installApp({ account: { login: `keep-org-${i}`, type: "Organization" }, repos: [repo] });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (await machine.keychain())[0]!.secret;
  const preflight = await api("POST", "/preflight", token, { repository: repo.fullName });
  expect(preflight.status).toBe(200);
  const seen = preflight.body as { account: { id: number }; token: { id: string } };
  let pulls = 0;
  const oidc = (pull: Pull) => world.github.oidc.tokenFor({ repo, sha: pull.sha, ref: `refs/pull/${pull.number}/merge`, eventName: "pull_request" }, AUDIENCE);
  return {
    user,
    repo,
    fixture,
    machine,
    token,
    tokenId: seen.token.id,
    async logout() {
      expect((await world.runCli(["logout"], { cwd: machine.home, machine })).exitCode).toBe(0);
    },
    async pull() {
      const number = ++pulls;
      await fixture.checkout("main");
      await fixture.branch(`change-${number}`);
      await fixture.commit(`Change ${number}`, { [`src/change-${number}.js`]: `export const n = ${number};\n` });
      await fixture.push();
      const merge = await fixture.testMerge({ base: "main", head: `change-${number}`, number });
      return { number, sha: merge.sha, tree: await fixture.tree(merge.sha) };
    },
    async attest(pull) {
      const endedAt = new Date(world.clock.now().getTime() - 1_000).toISOString();
      const payload = {
        format: "testnotary.attestation/v1",
        repository: repo.id,
        suite: "test",
        command: ["node", "-e", "process.exit(0)"],
        tree: pull.tree,
        commit: pull.sha,
        outcome: "passed",
        attester: { account: seen.account.id, token: seen.token.id, tokenKind: "laptop" },
        endedAt,
      };
      const stored = await api("POST", "/runs", token, {
        repository: repo.fullName,
        outcome: "passed",
        suite: "test",
        tree: pull.tree,
        commit: pull.sha,
        command: payload.command,
        exitCode: 0,
        startedAt: new Date(Date.parse(endedAt) - 2_000).toISOString(),
        endedAt,
        durationMs: 2_000,
        environment: RUN_ENVIRONMENT,
        session: null,
        passedEnv: [],
        guardedMatched: [],
        warnings: [],
        notPinned: [],
        baselineOverrides: [],
        attestation: { payload: JSON.stringify(payload) },
      });
      expect(stored.status).toBe(201);
      const body = stored.body as { run: { id: string }; attestation: { id: string } };
      return { runId: body.run.id, attestationId: body.attestation.id };
    },
    async verify(pull) {
      const answer = await api("POST", "/verifications", await oidc(pull), { suite: "test", environment: CI_ENVIRONMENT });
      expect(answer.status).toBe(200);
      return answer.body.verification as { id: string; result: string };
    },
    async report(pull, verification, outcome) {
      const answer = await api("POST", `/verifications/${verification}/report`, await oidc(pull), { outcome, durationMs: 4_200, environment: CI_ENVIRONMENT });
      expect(answer.status).toBe(201);
      return answer.body as { mismatch: { id: string } | null };
    },
    async readRun(runId) {
      return (await api("GET", `/runs/${runId}`, token)).status;
    },
    async readVerification(pull, id) {
      return (await api("GET", `/verifications/${id}`, await oidc(pull))).status;
    },
  };
}

/** Runs `act` with the world clock at `at`, then puts it back to real time. */
async function at<T>(when: Date, act: () => Promise<T>): Promise<T> {
  world.clock.set(when);
  try {
    return await act();
  } finally {
    world.clock.reset();
  }
}

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysOn = (days: number) => new Date(Date.now() + days * DAY_MS);

/** One table's rows from every table's dump, as JSON text (empty array when none). */
async function table(name: string): Promise<string> {
  const lines = (await world.db.dump()).split("\n");
  const index = lines.indexOf(name);
  if (index < 0) throw new Error(`no table ${name}`);
  return lines[index + 1]!;
}

describe("the 90-day prune", () => {
  test("deletes runs, attestations, verifications and job reports older than 90 days, and keeps younger ones", async () => {
    const h = await history();
    const oldPull = await h.pull();
    const old = await at(daysAgo(91), async () => {
      const attested = await h.attest(oldPull);
      const verification = await h.verify(oldPull);
      expect(verification.result).toBe("would_skip");
      await h.report(oldPull, verification.id, "passed");
      return { ...attested, verification: verification.id };
    });
    const recentPull = await h.pull();
    const recent = await at(daysAgo(89), async () => {
      const attested = await h.attest(recentPull);
      const verification = await h.verify(recentPull);
      await h.report(recentPull, verification.id, "passed");
      return { ...attested, verification: verification.id };
    });

    await world.runRetentionJob();

    expect(await h.readRun(old.runId)).toBe(404);
    expect(await h.readVerification(oldPull, old.verification)).toBe(404);
    expect(await h.readRun(recent.runId)).toBe(200);
    expect(await h.readVerification(recentPull, recent.verification)).toBe(200);
    const dump = await world.db.dump();
    for (const id of [old.runId, old.attestationId, old.verification]) expect(dump).not.toContain(id);
    expect(dump).not.toContain(oldPull.tree);
    for (const id of [recent.runId, recent.attestationId, recent.verification]) expect(dump).toContain(id);
  });
});

describe("tokens", () => {
  test("a token goes 90 days after its revocation when nothing kept points at it, and its hash at once", async () => {
    const h = await history();
    await h.logout();

    await world.runRetentionJob();
    expect(await table("token_secrets")).not.toContain(h.tokenId);
    expect(await table("tokens")).toContain(h.tokenId);

    await world.runRetentionJob({ at: daysOn(89) });
    expect(await table("tokens")).toContain(h.tokenId);

    await world.runRetentionJob({ at: daysOn(91) });
    expect(await table("tokens")).not.toContain(h.tokenId);
    expect(await table("token_revocations")).not.toContain(h.tokenId);
    expect(await table("token_uses")).not.toContain(h.tokenId);
  });

  test("an expired sandbox token goes 90 days after its expiry", async () => {
    const h = await history();
    const value = await world.sandboxToken({ creator: h.user, repo: h.repo, name: "short-lived", days: 1 });
    const sandbox = (await api("POST", "/preflight", value, { repository: h.repo.fullName })).body as { token: { id: string } };

    await world.runRetentionJob({ at: daysOn(90) });
    expect(await table("tokens")).toContain(sandbox.token.id);

    await world.runRetentionJob({ at: daysOn(92) });
    expect(await table("tokens")).not.toContain(sandbox.token.id);
  });

  test("a revoked token a mismatch names stays, with the mismatch, after its runs are pruned", async () => {
    const h = await history();
    const pull = await h.pull();
    const { runId } = await h.attest(pull);
    const verification = await h.verify(pull);
    const { mismatch } = await h.report(pull, verification.id, "failed");
    expect(mismatch).not.toBeNull();
    await h.logout();

    await world.runRetentionJob({ at: daysOn(181) });

    expect(await table("runs")).not.toContain(runId);
    expect(await table("verifications")).not.toContain(verification.id);
    expect(await table("mismatches")).toContain(mismatch!.id);
    expect(await table("tokens")).toContain(h.tokenId);
  });
});
