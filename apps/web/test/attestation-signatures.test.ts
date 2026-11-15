import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { sshSign, type FakeAccount, type FakeRepo, type SshKeyPair } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// A signed attestation's upload, through the API as any client meets it: the service checks the
// signature fields, stores every one of them with whether GitHub listed the key at upload, and
// serves them back. It only ever sees public halves. The library's and the action's side of the
// same story is in packages/action/test/signature-mode.test.ts.

const world = useWorld();

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT = "b".repeat(40);
const NAMESPACE = "attestation@testnotary.dev";
let n = 0;

interface Signer {
  repo: FakeRepo;
  user: FakeAccount;
  token: string;
  key: SshKeyPair;
  seen: { account: { id: number }; token: { id: string; kind: "laptop" | "sandbox" }; repository: { id: number } };
  post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  read(runId: string): Promise<{ attestation: { payload: string; signature: Record<string, unknown> | null } }>;
}

/** An installed repo, a writer signed in on a laptop past their preflight, and a fresh key of theirs. */
async function signer(): Promise<Signer> {
  const i = ++n;
  const fixture = await world.fixtureRepo();
  const repo = await world.hostOnGitHub(fixture, { owner: `sigstore-${i}`, name: "app" });
  await world.github.installApp({ account: { login: `sigstore-${i}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `sigstore-dev-${i}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (await machine.keychain())[0]!.secret;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${world.service.url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const preflight = await call("POST", "/preflight", { repository: repo.fullName });
  expect(preflight.status).toBe(200);
  return {
    repo,
    user,
    token,
    key: await world.sshKey(),
    seen: preflight.body as unknown as Signer["seen"],
    post: (body) => call("POST", "/runs", body),
    read: async (runId) => (await call("GET", `/runs/${runId}`)).body as unknown as Awaited<ReturnType<Signer["read"]>>,
  };
}

/** `ssh-keygen -lf`'s fingerprint of the key: the independent answer the stored one must equal. */
async function fingerprintOf(key: SshKeyPair): Promise<string> {
  const { stdout } = await promisify(execFile)("ssh-keygen", ["-l", "-f", `${key.privateKeyPath}.pub`]);
  return stdout.split(" ")[1]!;
}

/** The canonical v1 payload, written out here in its key order. */
function payloadText(s: Signer, endedAt: string): string {
  return JSON.stringify({
    format: "testnotary.attestation/v1",
    repository: s.seen.repository.id,
    suite: "test",
    command: ["npm", "test"],
    tree: TREE,
    commit: COMMIT,
    outcome: "passed",
    attester: { account: s.seen.account.id, token: s.seen.token.id, tokenKind: s.seen.token.kind },
    endedAt,
  });
}

/** A passed run's upload, signed with the signer's key unless `signature` says otherwise. */
async function signedRun(s: Signer, signature: (fields: Record<string, unknown>, payload: string) => Promise<Record<string, unknown>> | Record<string, unknown> = (fields) => fields) {
  const endedAt = new Date(world.clock.now().getTime() - 1_000).toISOString();
  const payload = payloadText(s, endedAt);
  const fields = {
    sshsig: await sshSign(s.key, payload, NAMESPACE),
    namespace: NAMESPACE,
    publicKey: s.key.publicKey,
    fingerprint: await fingerprintOf(s.key),
    keySource: "github",
    signer: { account: s.seen.account.id },
  };
  return {
    repository: s.repo.fullName,
    outcome: "passed",
    suite: "test",
    tree: TREE,
    commit: COMMIT,
    command: ["npm", "test"],
    exitCode: 0,
    startedAt: new Date(Date.parse(endedAt) - 2_000).toISOString(),
    endedAt,
    durationMs: 2_000,
    environment: { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" },
    session: null,
    passedEnv: [],
    guardedMatched: [],
    warnings: [],
    notPinned: [],
    baselineOverrides: [],
    attestation: { payload, signature: await signature(fields, payload) },
  };
}

describe("a signed attestation's upload", () => {
  test("stores every signature field, with GitHub listing the key at upload, and serves them back as stored", async () => {
    const s = await signer();
    world.github.addSigningKey(s.user, s.key.publicKey);
    const upload = await signedRun(s);
    const before = Date.now();

    const stored = await s.post(upload);

    expect(stored.status).toBe(201);
    const { attestation } = await s.read((stored.body.run as { id: string }).id);
    const [type, base64] = s.key.publicKey.split(" ");
    expect(attestation.payload).toBe(upload.attestation.payload);
    expect(attestation.signature).toEqual({
      sshsig: upload.attestation.signature.sshsig,
      namespace: NAMESPACE,
      publicKey: `${type} ${base64}`,
      fingerprint: await fingerprintOf(s.key),
      keySource: "github",
      signer: { account: s.user.id },
      githubListed: true,
      githubCheckedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
    });
    expect(Date.parse(attestation.signature!.githubCheckedAt as string)).toBeGreaterThanOrEqual(before - 1_000);
    expect(world.github.requestsTo("GET", `/users/${s.user.login}/ssh_signing_keys`)).toHaveLength(1);
  });

  test("records a key GitHub doesn't list as not listed, and still stores it (the action decides)", async () => {
    const s = await signer();

    const stored = await s.post(await signedRun(s));

    expect(stored.status).toBe(201);
    const { attestation } = await s.read((stored.body.run as { id: string }).id);
    expect(attestation.signature).toMatchObject({ keySource: "github", githubListed: false });
  });

  test("an allowed_signers key isn't looked up on GitHub", async () => {
    const s = await signer();

    const stored = await s.post(await signedRun(s, (fields) => ({ ...fields, keySource: "allowed_signers" })));

    expect(stored.status).toBe(201);
    const { attestation } = await s.read((stored.body.run as { id: string }).id);
    expect(attestation.signature).toMatchObject({ keySource: "allowed_signers", githubListed: null, githubCheckedAt: null });
    expect(world.github.requestsTo("GET", `/users/${s.user.login}/ssh_signing_keys`)).toHaveLength(0);
  });

  test("when GitHub can't be asked, the upload is stored with the listing unknown", async () => {
    const s = await signer();
    const restore = world.github.override("GET", "/users/:login/ssh_signing_keys", () => new Response("upstream", { status: 503 }));
    try {
      const stored = await s.post(await signedRun(s));

      expect(stored.status).toBe(201);
      const { attestation } = await s.read((stored.body.run as { id: string }).id);
      expect(attestation.signature).toMatchObject({ githubListed: null, githubCheckedAt: null });
    } finally {
      restore();
    }
  });

  test.each([
    {
      name: "a signature over other bytes",
      change: async (fields: Record<string, unknown>, payload: string, s: Signer) => ({ ...fields, sshsig: await sshSign(s.key, `${payload} `, NAMESPACE) }),
    },
    { name: "another namespace", change: async (fields: Record<string, unknown>, payload: string, s: Signer) => ({ ...fields, sshsig: await sshSign(s.key, payload, "git") }) },
    { name: "a public key that didn't make it", change: async (fields: Record<string, unknown>) => ({ ...fields, publicKey: (await world.sshKey()).publicKey }) },
    { name: "a fingerprint of another key", change: async (fields: Record<string, unknown>) => ({ ...fields, fingerprint: await fingerprintOf(await world.sshKey()) }) },
    { name: "a signer other than the token's account", change: (fields: Record<string, unknown>) => ({ ...fields, signer: { account: 1 } }) },
    { name: "a sandbox token as the signer of a laptop token's run", change: (fields: Record<string, unknown>, _: string, s: Signer) => ({ ...fields, signer: { sandboxToken: s.seen.token.id } }) },
  ])("refuses $name with attestation_invalid", async ({ change }) => {
    const s = await signer();

    const stored = await s.post(await signedRun(s, (fields, payload) => change(fields, payload, s)));

    expect(stored).toMatchObject({ status: 400, body: { error: "attestation_invalid" } });
  });

  test("refuses a private key in place of the public one, and never stores it", async () => {
    const s = await signer();

    const stored = await s.post(await signedRun(s, (fields) => ({ ...fields, publicKey: s.key.privateKey })));

    expect(stored).toMatchObject({ status: 400 });
  });
});
