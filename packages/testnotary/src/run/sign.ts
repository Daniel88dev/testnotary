// Signature mode on the run's side: when the base config says `"signatures": "required"`, the
// passed run's canonical payload is signed with `ssh-keygen -Y sign` under the namespace
// `attestation@testnotary.dev`, and the signature, the public key, its fingerprint, the key's
// source and the signer go up with the payload. Node can't load an OpenSSH private key, hence
// `ssh-keygen` (which also uses ssh-agent when only a public key is named).
//
// - A laptop token signs with the person's git SSH signing key (`gpg.format = ssh`,
//   `user.signingKey`: a key path, or `key::<public key>` held by ssh-agent). Its source is
//   `allowed_signers` when the base branch's `.testnotary/allowed_signers` lists it for the
//   person, else `github` (the person's GitHub signing keys).
// - A sandbox token signs with its own key from `TESTNOTARY_SIGNING_KEY` (what `sandbox-key`
//   printed); its source is always `allowed_signers`.
//
// No usable key, or a signature that fails: the run uploads unsigned with the `no_signing_key`
// warning, and CI falls back with `signature_missing`. The private key never leaves this machine.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { tryGit } from "../git.ts";
import { say } from "../report.ts";
import {
  ALLOWED_SIGNERS_FILE,
  SIGNATURE_NAMESPACE,
  SIGNING_KEY_VARIABLE,
  allowedSignerFor,
  attesterPrincipal,
  attesterSigner,
  decodeSigningKey,
  parseAllowedSigners,
  verifySshSignature,
  type AttestationPayload,
  type AttestationSignatureUpload,
} from "../shared.ts";
import { warn, type RunContext } from "./context.ts";

/** How long `ssh-keygen` may take: a hardware key waits for a touch. */
const SIGN_TIMEOUT_MS = 60_000;

/** The signature fields for the payload, or undefined (with the warning) when the run can't sign. */
export async function signAttestation(context: RunContext, payload: AttestationPayload, text: string): Promise<AttestationSignatureUpload | undefined> {
  const work = await mkdtemp(join(tmpdir(), "testnotary-sign-"));
  try {
    const key = payload.attester.tokenKind === "sandbox" ? await sandboxKey(context, work) : await laptopKey(context, work);
    if (!key) return undefined;
    const signed = await sshKeygenSign(key.file, text, context.env);
    if (signed.kind === "failed") return unsigned(context, `ssh-keygen could not sign with ${key.label} (${signed.reason})`);
    const check = await verifySshSignature(signed.signature, new TextEncoder().encode(text));
    if (!check.ok) return unsigned(context, `the signature ssh-keygen made with ${key.label} does not check (${check.problem})`);
    const keySource = payload.attester.tokenKind === "sandbox" || (await listedOnBase(context, payload, check.signature.publicKey)) ? "allowed_signers" : "github";
    say(`signed with ${check.fingerprint} (${keySource === "github" ? "a GitHub signing key" : ALLOWED_SIGNERS_FILE})`);
    return {
      sshsig: signed.signature,
      namespace: SIGNATURE_NAMESPACE,
      publicKey: check.publicKey,
      fingerprint: check.fingerprint,
      keySource,
      signer: attesterSigner(payload.attester),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface SigningKey {
  /** What `ssh-keygen -f` gets: a private key, or a public key whose private half is in ssh-agent. */
  file: string;
  /** How lines name it. */
  label: string;
}

function unsigned(context: RunContext, why: string): undefined {
  warn(context, "no_signing_key", `the repo requires signatures, but ${why}: the run uploads unsigned, and CI will run its tests (signature_missing)`);
  return undefined;
}

async function sandboxKey(context: RunContext, work: string): Promise<SigningKey | undefined> {
  const value = context.env[SIGNING_KEY_VARIABLE];
  if (!value) return unsigned(context, `${SIGNING_KEY_VARIABLE} is not set (make a key with \`testnotary sandbox-key <token-name>\` on your laptop and store it as this sandbox's secret)`);
  const privateKey = decodeSigningKey(value);
  if (!privateKey) return unsigned(context, `${SIGNING_KEY_VARIABLE} does not hold a key from \`testnotary sandbox-key\``);
  const file = join(work, "sandbox-key");
  await writeFile(file, privateKey, { mode: 0o600 });
  await chmod(file, 0o600);
  return { file, label: SIGNING_KEY_VARIABLE };
}

async function laptopKey(context: RunContext, work: string): Promise<SigningKey | undefined> {
  const format = await tryGit(context.root, ["config", "--get", "gpg.format"], context.env);
  const configured = await tryGit(context.root, ["config", "--get", "user.signingKey"], context.env);
  if (format !== "ssh" || !configured) {
    return unsigned(context, "git has no SSH signing key (set `git config gpg.format ssh` and `user.signingKey`, and add the key to GitHub as a signing key)");
  }
  if (configured.startsWith("key::")) {
    const file = join(work, "signing-key.pub");
    await writeFile(file, `${configured.slice("key::".length).trim()}\n`);
    return { file, label: "the user.signingKey public key" };
  }
  const home = context.env.HOME ?? homedir();
  const path = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return { file: isAbsolute(path) ? path : resolve(context.root, path), label: configured };
}

/** Whether the base branch's `allowed_signers` lists the key for the attester. */
async function listedOnBase(context: RunContext, payload: AttestationPayload, key: Parameters<typeof allowedSignerFor>[2]): Promise<boolean> {
  const text = await tryGit(context.root, ["show", `${context.base.ref}:${ALLOWED_SIGNERS_FILE}`], context.env);
  if (!text) return false;
  return allowedSignerFor(parseAllowedSigners(text), attesterPrincipal(payload.attester), key, new Date(payload.endedAt)) !== undefined;
}

type Signed = { kind: "signed"; signature: string } | { kind: "failed"; reason: string };

function sshKeygenSign(keyFile: string, text: string, env: RunContext["env"]): Promise<Signed> {
  return new Promise((done) => {
    const child = execFile(
      "ssh-keygen",
      ["-Y", "sign", "-n", SIGNATURE_NAMESPACE, "-f", keyFile],
      { env: { ...env }, timeout: SIGN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
          done({ kind: "failed", reason: missing ? "ssh-keygen is not installed" : (detail ?? error.message) });
        } else done({ kind: "signed", signature: stdout });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
