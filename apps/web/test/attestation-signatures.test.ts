import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

/** An armored SSH signature's fields (PROTOCOL.sshsig), as wire-format byte strings. */
interface SshsigParts {
  publicKey: Uint8Array;
  namespace: Uint8Array;
  reserved: Uint8Array;
  hashAlgorithm: Uint8Array;
  signature: Uint8Array;
}

const ascii = (text: string) => new TextEncoder().encode(text);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

/** SSH wire strings: each a 4-byte big-endian length and the bytes. */
function writeStrings(strings: Uint8Array[]): Uint8Array {
  return concatBytes(
    ...strings.flatMap((bytes) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}

/** Every SSH wire string in `bytes`, in order. */
function readStrings(bytes: Uint8Array): Uint8Array[] {
  const strings: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const length = Buffer.from(bytes.subarray(at, at + 4)).readUInt32BE();
    strings.push(bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return strings;
}

/** An RSA JWK number as an SSH mpint: unsigned, big-endian, with a leading zero when the top bit is set. */
function mpint(base64url: string): Uint8Array {
  const bytes = Buffer.from(base64url, "base64url");
  return bytes[0]! & 0x80 ? concatBytes(new Uint8Array([0]), bytes) : new Uint8Array(bytes);
}

function sshsigParts(armored: string): SshsigParts {
  const bytes = Buffer.from(armored.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  // "SSHSIG", then the version as a uint32, then five strings.
  const [publicKey, namespace, reserved, hashAlgorithm, signature] = readStrings(bytes.subarray(10));
  return { publicKey: publicKey!, namespace: namespace!, reserved: reserved!, hashAlgorithm: hashAlgorithm!, signature: signature! };
}

function armor(parts: SshsigParts): string {
  const body = concatBytes(ascii("SSHSIG"), new Uint8Array([0, 0, 0, 1]), writeStrings([parts.publicKey, parts.namespace, parts.reserved, parts.hashAlgorithm, parts.signature]));
  const lines = Buffer.from(body).toString("base64").match(/.{1,70}/g)!;
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** `SHA256:<base64 without padding>` of a key blob, as `ssh-keygen -l` prints it. */
function fingerprintOfBlob(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
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

  // What `ssh-keygen -Y verify` refuses although the signature checks out over the bytes: the
  // verifier must refuse them too. Each case rewrites a real signature's wire format and names the
  // rewritten key, so only the rule under test can refuse it.
  test.each([
    {
      name: "an ECDSA key whose type names another curve than its curve field",
      type: "ecdsa" as const,
      change: (parts: SshsigParts) => {
        const key = readStrings(parts.publicKey);
        const renamed = ascii("ecdsa-sha2-nistp384");
        const signature = readStrings(parts.signature);
        return { ...parts, publicKey: writeStrings([renamed, ...key.slice(1)]), signature: writeStrings([renamed, ...signature.slice(1)]) };
      },
    },
    {
      name: "a key blob with trailing bytes",
      type: "ed25519" as const,
      change: (parts: SshsigParts) => ({ ...parts, publicKey: concatBytes(parts.publicKey, new Uint8Array([0, 0, 0, 0])) }),
    },
    {
      name: "a signature blob with trailing bytes",
      type: "ed25519" as const,
      change: (parts: SshsigParts) => ({ ...parts, signature: concatBytes(parts.signature, new Uint8Array([0, 0, 0, 0])) }),
    },
    {
      name: "an ECDSA signature whose r and s blob has trailing bytes",
      type: "ecdsa" as const,
      change: (parts: SshsigParts) => {
        const [type, blob] = readStrings(parts.signature);
        return { ...parts, signature: writeStrings([type!, concatBytes(blob!, new Uint8Array([0, 0, 0, 0]))]) };
      },
    },
  ])("refuses $name with attestation_invalid", async ({ type, change }) => {
    const s = await signer();
    s.key = await world.sshKey({ type });

    const stored = await s.post(
      await signedRun(s, async (fields) => {
        const parts = change(sshsigParts(fields.sshsig as string));
        const key = `${new TextDecoder().decode(readStrings(parts.publicKey)[0])} ${Buffer.from(parts.publicKey).toString("base64")}`;
        return { ...fields, sshsig: armor(parts), publicKey: key, fingerprint: fingerprintOfBlob(parts.publicKey) };
      }),
    );

    expect(stored).toMatchObject({ status: 400, body: { error: "attestation_invalid" } });
  });

  test("refuses an RSA key under 1024 bits, as ssh-keygen does", async () => {
    const s = await signer();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 768 });
    const jwk = publicKey.export({ format: "jwk" });
    const blob = writeStrings([ascii("ssh-rsa"), mpint(jwk.e!), mpint(jwk.n!)]);

    const stored = await s.post(
      await signedRun(s, (fields, payload) => {
        const hashed = createHash("sha512").update(payload).digest();
        const signed = concatBytes(ascii("SSHSIG"), writeStrings([ascii(NAMESPACE), new Uint8Array(), ascii("sha512"), hashed]));
        const parts: SshsigParts = {
          publicKey: blob,
          namespace: ascii(NAMESPACE),
          reserved: new Uint8Array(),
          hashAlgorithm: ascii("sha512"),
          signature: writeStrings([ascii("rsa-sha2-512"), sign("sha512", signed, privateKey)]),
        };
        return { ...fields, sshsig: armor(parts), publicKey: `ssh-rsa ${Buffer.from(blob).toString("base64")}`, fingerprint: fingerprintOfBlob(blob) };
      }),
    );

    expect(stored).toMatchObject({ status: 400, body: { error: "attestation_invalid" } });
  });

  test("refuses a private key in place of the public one, and never stores it", async () => {
    const s = await signer();

    const stored = await s.post(await signedRun(s, (fields) => ({ ...fields, publicKey: s.key.privateKey })));

    expect(stored).toMatchObject({ status: 400 });
  });
});
