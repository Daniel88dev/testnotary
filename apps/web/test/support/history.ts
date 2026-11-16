import { expect } from "vitest";
import type { FakeAccount, FakeInstallation, FakeRepo, FixtureRepo, Machine, World } from "@testnotary/test-world";

// A repo's history made through the API the way the library and CI make it (a developer's run
// upload with their laptop token; CI's verification and job report with the job's OIDC token), at
// the world clock's time, so a test can make history in the past. For the retention and repo
// lifecycle tests.

export const DAY_MS = 86_400_000;
const AUDIENCE = "https://testnotary.dev";
const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
const RUN_ENVIRONMENT = { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" };

export interface Pull {
  number: number;
  sha: string;
  tree: string;
}

export interface History {
  /** The developer: an admin of the repo, signed in on a laptop. */
  user: FakeAccount;
  repo: FakeRepo;
  installation: FakeInstallation;
  fixture: FixtureRepo;
  machine: Machine;
  /** The laptop token's value and id. */
  token: string;
  tokenId: string;
  /** `testnotary logout` on the laptop: revokes the token. */
  logout(): Promise<void>;
  /** A pull request off main with one change; returns GitHub's test merge commit and its tree. */
  pull(): Promise<Pull>;
  /** The developer's passed run on the pull request's tree, uploaded at the world clock's time. */
  attest(pull: Pull): Promise<{ runId: string; attestationId: string }>;
  /** CI's verification of the pull request's merge commit: the answer's status and body. */
  ask(pull: Pull): Promise<{ status: number; body: Record<string, unknown> }>;
  /** CI's verification of the pull request's merge commit, which must be answered; its id and result. */
  verify(pull: Pull): Promise<{ id: string; result: string }>;
  report(pull: Pull, verification: string, outcome: "passed" | "failed"): Promise<{ mismatch: { id: string } | null }>;
  /** A run of the developer's, read back with their laptop token: its status. */
  readRun(runId: string): Promise<number>;
  /** A verification, read back by the repo's CI: its status. */
  readVerification(pull: Pull, id: string): Promise<number>;
}

export interface Histories {
  /** An installed public repo of its own organization (shadow mode) and its admin, signed in on a laptop. */
  history(): Promise<History>;
  api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Runs `act` with the world clock at `when`, then puts it back to real time. */
  at<T>(when: Date, act: () => Promise<T>): Promise<T>;
  /** One table's rows, from a dump of every table, as JSON text. */
  table(name: string): Promise<string>;
}

export const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
export const daysOn = (days: number) => new Date(Date.now() + days * DAY_MS);

/** History helpers for one test file's world; `prefix` keeps its logins and organizations apart. */
export function histories(world: World, prefix: string): Histories {
  let n = 0;

  async function api(method: string, path: string, token: string, body?: unknown) {
    const response = await fetch(`${world.service.url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function history(): Promise<History> {
    const i = ++n;
    const user = world.github.addUser({ login: `${prefix}-dev-${i}` });
    const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
    const repo = await world.hostOnGitHub(fixture, { owner: `${prefix}-org-${i}`, name: "ledger", visibility: "public" });
    const { installation } = await world.github.installApp({ account: { login: `${prefix}-org-${i}`, type: "Organization" }, repos: [repo] });
    world.github.setPermission(repo, user, "admin");
    const machine = await world.machine();
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
    const token = (await machine.keychain())[0]!.secret;
    const preflight = await api("POST", "/preflight", token, { repository: repo.fullName });
    expect(preflight.status).toBe(200);
    const seen = preflight.body as { account: { id: number }; token: { id: string } };
    let pulls = 0;
    const oidc = (pull: Pull) => world.github.oidc.tokenFor({ repo, sha: pull.sha, ref: `refs/pull/${pull.number}/merge`, eventName: "pull_request" }, AUDIENCE);
    const ask = async (pull: Pull) => api("POST", "/verifications", await oidc(pull), { suite: "test", environment: CI_ENVIRONMENT });
    return {
      user,
      repo,
      installation,
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
      ask,
      async verify(pull) {
        const answer = await ask(pull);
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

  return {
    history,
    api,
    async at(when, act) {
      world.clock.set(when);
      try {
        return await act();
      } finally {
        world.clock.reset();
      }
    },
    async table(name) {
      const lines = (await world.db.dump()).split("\n");
      const index = lines.indexOf(name);
      if (index < 0) throw new Error(`no table ${name}`);
      return lines[index + 1]!;
    },
  };
}
