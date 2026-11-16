import { describe, expect, test } from "vitest";
import { encodeAttestationPayload, decodeAttestationPayload, type AttestationPayload, type Verification } from "@testnotary/protocol";
import { fromJob, githubError, json, notFound, sshSign, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine, type SshKeyPair } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The action's signature check against a compromised service. In signature mode the service is
// trusted only for the audit draw and for revocations that don't remove a key, so each case puts a
// lying service in front of the real one: it answers `skip` with an attestation of its choosing.
// The developer really attested with their GitHub signing key first; each case then breaks exactly
// one of the seven conditions, and the action must fall back with `signature_invalid` and a detail
// naming that check. The gate job (`mode: verify`) runs on a `fetch-depth: 2` checkout.

const world = useWorld();

const SIGNED = { signatures: "required", suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };
const NAMESPACE = "attestation@testnotary.dev";

type Attestation = NonNullable<Verification["attestation"]>;

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  key: SshKeyPair;
  /** The attestation the developer's run really made, as the service stored it. */
  attestation: Attestation;
  payload: AttestationPayload;
  /**
   * The gate job on the pull request's test merge commit, against `service` (default: the honest
   * one), on a `fetchDepth` checkout, or with no checkout at all.
   */
  gate(options?: { service?: string; fetchDepth?: number; checkout?: boolean }): ReturnType<typeof world.runAction>;
  /** The base branch moves on with this config; the gate then runs on the new merge commit against `service`. */
  gateAfterBaseConfig(config: string, service: string): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** A signature-mode repo in enforce mode; the writer attests the pull request's branch on their laptop, signing with their GitHub key. */
async function scene(options: { files?: Record<string, string> } = {}): Promise<Scene> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: SIGNED, files: { "package.json": '{ "name": "vault", "private": true }\n' } });
  const repo = await world.hostOnGitHub(fixture, { owner: `sigcheck-${n}`, name: "vault" });
  await world.github.installApp({ account: { login: `sigcheck-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `sigcheck-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  const key = await world.sshKey();
  world.github.addSigningKey(user, key.publicKey);
  await fixture.git("config", "gpg.format", "ssh");
  await fixture.git("config", "user.signingKey", key.privateKeyPath);

  await fixture.branch("feature");
  await fixture.commit("Change the vault", { "src/vault.js": "export const vault = 1;\n", ...options.files });
  await fixture.push();
  const attestation = await attest(fixture, machine);
  await world.audits.forbid(repo);
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  return {
    fixture,
    repo,
    user,
    key,
    attestation,
    payload: decodeAttestationPayload(attestation.payload!)!,
    async gateAfterBaseConfig(config, service) {
      await fixture.checkout("main");
      await fixture.commit("Change the config", { "testnotary.json": config });
      await fixture.push();
      const moved = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(moved.sha, { fetchDepth: 2 });
      return world.runAction({ repo, sha: moved.sha, workspace, inputs: { suite: "test", mode: "verify" }, env: { TESTNOTARY_URL: service } });
    },
    async gate({ service, fetchDepth = 2, checkout = true } = {}) {
      const workspace = checkout ? await fixture.ciCheckout(merge.sha, { fetchDepth }) : (await world.machine()).home;
      return world.runAction({
        repo,
        sha: merge.sha,
        workspace,
        inputs: { suite: "test", mode: "verify" },
        env: service ? { TESTNOTARY_URL: service } : undefined,
      });
    },
  };
}

/** `testnotary run` on the laptop; returns the attestation as the service stored it, signature included. */
async function attest(fixture: FixtureRepo, machine: Machine): Promise<Attestation> {
  const result = await world.runCli(["run", "--json"], { cwd: fixture.dir, machine });
  const report = JSON.parse(result.stdout) as { attested: boolean; attestationUrl: string };
  expect(report.attested).toBe(true);
  const [entry] = await machine.keychain();
  const response = await fetch(`${world.service.url}/api/v1/runs/${report.attestationUrl.split("/").at(-1)}`, { headers: { authorization: `Bearer ${entry!.secret}` } });
  const { run, attestation } = (await response.json()) as {
    run: { id: string; endedAt: string; environment: Attestation["run"]["environment"]; session: null; account: { id: number; login: string }; token: { kind: "laptop" } };
    attestation: { id: string; format: string; payload: string; signature: Attestation["signature"] };
  };
  expect(attestation.signature).toMatchObject({ keySource: "github" });
  return {
    id: attestation.id,
    run: { id: run.id, environment: run.environment, session: run.session },
    format: attestation.format,
    payload: attestation.payload,
    signature: attestation.signature,
    endedAt: run.endedAt,
    attester: { account: run.account, token: { kind: run.token.kind, name: "laptop" } },
  };
}

/**
 * A lying service: every verification answers `skip` on `attestation` (the real one unless the
 * case swapped its bytes or signature), whatever the real service decided.
 */
function lyingService(attestation: Attestation): Promise<string> {
  return world.compromisedService<Verification>((honest) => ({ ...honest, result: "skip", reason: null, detail: null, attestation }));
}

/** The real attestation with other bytes, signed by `key` (default: the developer's own GitHub key). */
async function resigned(s: Scene, payload: AttestationPayload, options: { key?: SshKeyPair; namespace?: string } = {}): Promise<Attestation> {
  const text = encodeAttestationPayload(payload);
  const sshsig = await sshSign(options.key ?? s.key, text, options.namespace ?? NAMESPACE);
  return { ...s.attestation, payload: text, signature: { ...s.attestation.signature!, sshsig } };
}

/** The PR line: the bold line of the job summary. */
function line(summary: string): string {
  return /\*\*(.+)\*\*/.exec(summary)?.[1] ?? "";
}

const HOUR = 3_600_000;

interface Case {
  /** The condition the case breaks, as the spec lists it. */
  condition: string;
  files?: Record<string, string>;
  /** What the lying service serves, and anything else the case changes after the run attested. */
  arrange(s: Scene): Promise<Attestation>;
  detail: string | RegExp | ((s: Scene) => string);
}

const CASES: Case[] = [
  {
    condition: "1. signature over the exact bytes",
    // One byte of the payload changed, the signature left as it was.
    arrange: async (s) => ({ ...s.attestation, payload: encodeAttestationPayload({ ...s.payload, commit: s.payload.commit.replace(/^./, (c) => (c === "0" ? "1" : "0")) }) }),
    detail: "signature: not valid over the attestation's bytes",
  },
  {
    condition: "1. under the namespace attestation@testnotary.dev",
    arrange: (s) => resigned(s, s.payload, { namespace: "git" }),
    detail: 'signature: made under namespace "git", not attestation@testnotary.dev',
  },
  {
    condition: "1. with a key from GitHub or allowed_signers",
    arrange: async (s) => resigned(s, s.payload, { key: await world.sshKey() }),
    detail: (s) => `signature: the key is neither among @${s.user.login}'s GitHub signing keys nor in .testnotary/allowed_signers at HEAD^1`,
  },
  {
    condition: "2. the signed tree is HEAD^{tree}",
    arrange: async (s) => resigned(s, { ...s.payload, tree: await s.fixture.tree("main") }),
    detail: /^tree: signed for [0-9a-f]{12}, not HEAD\^\{tree\} [0-9a-f]{12}$/,
  },
  {
    condition: "3. the repo id is GITHUB_REPOSITORY_ID",
    arrange: (s) => resigned(s, { ...s.payload, repository: s.repo.id + 1 }),
    detail: (s) => `repository: signed for repo id ${s.repo.id + 1}, not ${s.repo.id}`,
  },
  {
    condition: "3. the suite matches",
    arrange: (s) => resigned(s, { ...s.payload, suite: "e2e" }),
    detail: 'suite: signed for suite "e2e", not "test"',
  },
  {
    condition: "4. the command is the suite's at HEAD^1",
    arrange: (s) => resigned(s, { ...s.payload, command: ["node", "-e", "process.exit(0)", "--", "--only-changed"] }),
    detail: "command: the signed command is not the suite's command in testnotary.json at HEAD^1",
  },
  {
    condition: "5. signed under 24 h ago",
    arrange: (s) => resigned(s, { ...s.payload, endedAt: new Date(Date.now() - 25 * HOUR).toISOString() }),
    detail: /^age: signed 25 h ago, not under 24 h$/,
  },
  {
    condition: "5. not in the future (5 min of skew)",
    arrange: (s) => resigned(s, { ...s.payload, endedAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    detail: "age: signed in the future",
  },
  {
    condition: "6. the signer has admin or write",
    arrange: async (s) => {
      world.github.setPermission(s.repo, s.user, "read");
      return s.attestation;
    },
    detail: (s) => `permission: @${s.user.login} has read, not admin or write`,
  },
  {
    condition: "7. no guarded file in git diff HEAD^1 HEAD",
    files: { "package.json": '{ "name": "vault", "private": true, "scripts": { "postinstall": "node steal.js" } }\n' },
    arrange: async (s) => s.attestation,
    detail: "guarded file: package.json",
  },
];

describe("a lying service's skip falls back when the signature check fails one condition", () => {
  test.each(CASES)("$condition", async ({ files, arrange, detail }) => {
    const s = await scene({ files });
    const service = await lyingService(await arrange(s));

    const result = await s.gate({ service });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    const shown = /^Fell back: signature_invalid \((.+)\), the attestation's signature did not pass the signature check$/.exec(line(result.summary))?.[1];
    if (detail instanceof RegExp) expect(shown).toMatch(detail);
    else expect(shown).toBe(typeof detail === "function" ? detail(s) : detail);
  });

  test("the same lie with every condition holding skips: the check is what stops the others", async () => {
    const s = await scene();
    const service = await lyingService(s.attestation);

    const result = await s.gate({ service });

    expect(result.outputs).toMatchObject({ result: "skip", skip: "true" });
  });
});

describe("the signature check's GitHub calls", () => {
  test("an account id GitHub no longer knows (404) is signature_invalid", async () => {
    const s = await scene();
    // Gone by the time CI asks (the service, asked first, still found it).
    const restore = world.github.override("GET", "/user/:id", () => notFound(), { when: fromJob });
    try {
      const result = await s.gate();

      expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid" });
      expect(line(result.summary)).toContain(`(signature: GitHub account ${s.user.id} no longer exists)`);
    } finally {
      restore();
    }
  });

  test("a rate-limited signing keys call is github_unavailable", async () => {
    const s = await scene();
    const restore = world.github.override("GET", "/users/:login/ssh_signing_keys", () =>
      json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1999999999" }),
    );
    try {
      const result = await s.gate();

      expect(result.outputs).toMatchObject({ result: "fallback", reason: "github_unavailable", skip: "false" });
      expect(line(result.summary)).toBe(
        `Fell back: github_unavailable (GET /users/${s.user.login}/ssh_signing_keys was rate-limited), GitHub could not be asked`,
      );
    } finally {
      restore();
    }
  });

  test("a failing permission call is github_unavailable", async () => {
    const s = await scene();
    const restore = world.github.override("GET", "/repos/:owner/:repo/collaborators/:username/permission", () => githubError(502, "Server Error"), { when: fromJob });
    try {
      const result = await s.gate();

      expect(result.outputs).toMatchObject({ result: "fallback", reason: "github_unavailable" });
      expect(line(result.summary)).toContain(`(GET /repos/${s.repo.fullName}/collaborators/${s.user.login}/permission answered 502)`);
    } finally {
      restore();
    }
  });

  test("the keys and permission calls are made after the account lookup, side by side, with no cache headers", async () => {
    const s = await scene();
    const since = world.github.requests.length;

    const result = await s.gate();

    expect(result.outputs).toMatchObject({ result: "skip" });
    const calls = world.github.requests.slice(since).filter((r) => r.method === "GET" && r.headers.authorization?.startsWith("Bearer ghs_job_"));
    expect(calls.map((r) => r.path)[0]).toBe(`/user/${s.user.id}`);
    expect(calls.slice(1).map((r) => r.path).sort()).toEqual([`/repos/${s.repo.fullName}/collaborators/${s.user.login}/permission`, `/users/${s.user.login}/ssh_signing_keys`]);
    for (const call of calls) {
      expect(call.headers["if-none-match"]).toBeUndefined();
      expect(call.headers["if-modified-since"]).toBeUndefined();
    }
  });
});

describe("the checkout", () => {
  test("without HEAD^1 (fetch-depth: 1) a signature-mode repo can't be checked, and falls back", async () => {
    const s = await scene();

    const result = await s.gate({ fetchDepth: 1 });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    expect(line(result.summary)).toContain("(checkout: the repo requires signatures and HEAD^1 is missing; check out with fetch-depth: 2)");
  });

  // Whether the repo requires signatures is read from the base, never from the checkout or the
  // service: a lying service's skip must not stand just because the job can't read the base itself.
  test("a gate job with no checkout reads the base config through GitHub, and a lying skip falls back", async () => {
    const s = await scene();
    const service = await lyingService(s.attestation);

    const result = await s.gate({ service, checkout: false });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    expect(line(result.summary)).toContain("(checkout: the repo requires signatures and the job has no checkout; check out with fetch-depth: 2)");
    const byJob = world.github.requestsTo("GET", `/repos/${s.repo.fullName}/contents/testnotary.json`).filter((r) => r.headers.authorization?.startsWith("Bearer ghs_job_"));
    expect(byJob).toHaveLength(1);
  });

  test("a pull request that deletes the requirement from its own config still gets the base's check on a fetch-depth: 1 checkout", async () => {
    const unsigned = { suites: SIGNED.suites };
    const s = await scene({ files: { "testnotary.json": `${JSON.stringify(unsigned)}\n` } });
    const service = await lyingService(s.attestation);

    const result = await s.gate({ service, fetchDepth: 1 });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    expect(line(result.summary)).toContain("(checkout: the repo requires signatures and HEAD^1 is missing; check out with fetch-depth: 2)");
  });

  test("a base config this action's parser rejects (a key from a later release) still requires signatures", async () => {
    const s = await scene();
    const service = await lyingService(s.attestation);

    const result = await s.gateAfterBaseConfig(`${JSON.stringify({ ...SIGNED, someLaterKey: true })}\n`, service);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    expect(line(result.summary)).toMatch(/\(config: testnotary\.json at HEAD\^1 requires signatures, but this action can't read it: .+\)/);
  });

  test("a base config that isn't JSON falls back: whether it requires signatures can't be told", async () => {
    const s = await scene();
    const service = await lyingService(s.attestation);

    const result = await s.gateAfterBaseConfig("{ not json", service);

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "signature_invalid", skip: "false" });
    expect(line(result.summary)).toContain("(config: testnotary.json at HEAD^1 is unreadable)");
  });

  test("with no checkout, a GitHub call that fails while reading the base config is github_unavailable", async () => {
    const s = await scene();
    const restore = world.github.override("GET", "/repos/:owner/:repo/contents/:path", () => githubError(502, "Server Error"), { when: fromJob });
    try {
      const result = await s.gate({ checkout: false });

      expect(result.outputs).toMatchObject({ result: "fallback", reason: "github_unavailable", skip: "false" });
    } finally {
      restore();
    }
  });
});
