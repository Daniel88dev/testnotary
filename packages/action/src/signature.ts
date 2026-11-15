// The signature check (signature mode only), run before the action trusts a skip. In signature
// mode the service is trusted only for the audit draw and for revocations that don't remove a key:
// the action reads the base config, the allowed signers and the diff from its own checkout
// (`fetch-depth: 2`), asks GitHub for the signer's keys and permission with the job's
// `GITHUB_TOKEN`, and checks the signature over the attestation's exact bytes itself. A skip
// stands only when all seven conditions hold:
//
// 1. signature: valid over the exact bytes, under `attestation@testnotary.dev`, with a key from
//    the signer's GitHub signing keys or from `.testnotary/allowed_signers` at `HEAD^1`
// 2. tree: the signed tree is `HEAD^{tree}`
// 3. repository and suite: the signed repo id is `GITHUB_REPOSITORY_ID`, the suite the job's
// 4. command: the suite's command in `testnotary.json` at `HEAD^1`
// 5. age: signed under 24 h ago, and not in the future (5 min of skew)
// 6. permission: the signer has `admin` or `write`, after resolving the account id to a login
// 7. guarded file: none in `git diff --name-only HEAD^1 HEAD`
//
// No signature is `signature_missing`; a failed condition `signature_invalid`, its detail naming
// the check; a failed or rate-limited GitHub call `github_unavailable`. Every one runs the tests.
import { execFile } from "node:child_process";
import {
  ALLOWED_SIGNERS_FILE,
  CONFIG_FILE,
  allowedSignerFor,
  attesterPrincipal,
  decodeAttestationPayload,
  guardedGlobs,
  guardedMatches,
  parseAllowedSigners,
  parseConfig,
  parsePublicKey,
  sameKey,
  suiteFromConfig,
  suiteNames,
  verifySshSignature,
  type AttestationPayload,
  type FallbackReason,
  type TestnotaryConfig,
} from "./shared.ts";
import { input, type RunnerEnv } from "./runner.ts";
import type { Verdict } from "./verify.ts";

/** How old a signature may be, counted from its signing time (the run's end). */
export const SIGNATURE_MAX_AGE_MS = 24 * 3_600_000;
/** How far the signing time may lie ahead of the runner's clock. */
export const SIGNATURE_CLOCK_SKEW_MS = 5 * 60_000;
/** Each GitHub call's budget. Nothing is retried or cached. */
const GITHUB_TIMEOUT_MS = 10_000;

/**
 * The verdict the job acts on: a `skip` in a repo whose base config requires signatures stands
 * only when the attestation's signature passes the check; otherwise the job falls back (keeping
 * the service's record, so the tests still report against it). Any other verdict is returned as
 * it is: only a skip is ever trusted.
 */
export async function checkSkip(env: RunnerEnv, verdict: Verdict, suiteInput: string | null): Promise<Verdict> {
  if (verdict.result !== "skip") return verdict;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const mode = await signatureMode(workspace);
  if (mode.kind === "off") return verdict;
  const fallBack = (reason: FallbackReason, detail: string | null = null): Verdict => ({ result: "fallback", reason, detail, record: verdict.record });
  if (mode.kind === "no_parent") {
    return fallBack("signature_invalid", "checkout: the repo requires signatures and HEAD^1 is missing; check out with fetch-depth: 2");
  }
  const attestation = verdict.record?.attestation;
  if (!attestation?.signature || attestation.payload === null) return fallBack("signature_missing");
  const failed = await signatureProblem(env, workspace, mode.config, suiteInput, attestation.payload, attestation.signature.sshsig);
  return failed ? fallBack(failed.reason, failed.detail) : verdict;
}

type Mode = { kind: "off" } | { kind: "required"; config: TestnotaryConfig } | { kind: "no_parent" };

/**
 * Whether the repo requires signatures, from `testnotary.json` at `HEAD^1`. A checkout without
 * `HEAD^1` (the default `fetch-depth: 1`) whose own config requires them can't be checked. Without
 * a checkout at all (a gate job with no `actions/checkout`), nothing can be read: the action then
 * trusts the service, which is why signature mode's gate job needs a checkout.
 */
async function signatureMode(workspace: string): Promise<Mode> {
  const parent = await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD^1^{commit}"]);
  if (parent === undefined) {
    const own = await git(workspace, ["show", `HEAD:${CONFIG_FILE}`]);
    const parsed = own === undefined ? undefined : parseConfig(own);
    return parsed?.ok && parsed.config.signatures === "required" ? { kind: "no_parent" } : { kind: "off" };
  }
  const text = await git(workspace, ["show", `HEAD^1:${CONFIG_FILE}`]);
  const parsed = text === undefined ? undefined : parseConfig(text);
  return parsed?.ok && parsed.config.signatures === "required" ? { kind: "required", config: parsed.config } : { kind: "off" };
}

interface Problem {
  reason: "signature_invalid" | "github_unavailable";
  detail: string;
}

const invalid = (detail: string): Problem => ({ reason: "signature_invalid", detail });

/** The first condition that fails, or undefined when all seven hold. */
async function signatureProblem(
  env: RunnerEnv,
  workspace: string,
  base: TestnotaryConfig,
  suiteInput: string | null,
  text: string,
  sshsig: string,
): Promise<Problem | undefined> {
  // 1, the bytes: the signature over the exact payload, under the namespace. Then read it.
  const check = await verifySshSignature(sshsig, new TextEncoder().encode(text));
  if (!check.ok) return invalid(`signature: ${check.problem}`);
  const payload = decodeAttestationPayload(text);
  if (!payload) return invalid("signature: the signed bytes are not a canonical attestation");

  // 2. The tree CI checked out.
  const tree = await git(workspace, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (payload.tree !== tree) return invalid(`tree: signed for ${payload.tree.slice(0, 12)}, not HEAD^{tree} ${(tree ?? "").slice(0, 12)}`);

  // 3. This repo, this job's suite.
  if (String(payload.repository) !== env.GITHUB_REPOSITORY_ID) {
    return invalid(`repository: signed for repo id ${payload.repository}, not ${env.GITHUB_REPOSITORY_ID ?? "GITHUB_REPOSITORY_ID"}`);
  }
  const names = suiteNames(base);
  const suite = suiteInput ?? (names.length === 1 ? names[0]! : undefined);
  if (payload.suite !== suite) return invalid(`suite: signed for suite "${payload.suite}", not "${suite ?? "(none named)"}"`);

  // 4. The base config's command.
  const command = suiteFromConfig(base, payload.suite)?.command;
  if (!command || JSON.stringify(command) !== JSON.stringify(payload.command)) return invalid("command: the signed command is not the suite's command in testnotary.json at HEAD^1");

  // 5. Age, on the runner's clock.
  const signedAt = Date.parse(payload.endedAt);
  const now = Date.now();
  if (signedAt > now + SIGNATURE_CLOCK_SKEW_MS) return invalid("age: signed in the future");
  if (now - signedAt >= SIGNATURE_MAX_AGE_MS) return invalid(`age: signed ${Math.floor((now - signedAt) / 3_600_000)} h ago, not under 24 h`);

  // 7. No guarded file in the change (both sides of a rename).
  const diff = await git(workspace, ["diff", "--name-only", "-z", "--no-renames", "HEAD^1", "HEAD"]);
  if (diff === undefined) return invalid("guarded file: the change against HEAD^1 could not be read");
  const [guarded] = guardedMatches(diff.split("\0").filter(Boolean), guardedGlobs(base));
  if (guarded) return invalid(`guarded file: ${guarded.path}`);

  // 1, the key, and 6: trusted through allowed_signers (no call for the key) or GitHub's signing keys.
  return trustedSigner(env, workspace, payload, check.signature.publicKey);
}

async function trustedSigner(env: RunnerEnv, workspace: string, payload: AttestationPayload, key: Parameters<typeof sameKey>[0]): Promise<Problem | undefined> {
  const principal = attesterPrincipal(payload.attester);
  const signers = await git(workspace, ["show", `HEAD^1:${ALLOWED_SIGNERS_FILE}`]);
  const listed = signers !== undefined && allowedSignerFor(parseAllowedSigners(signers), principal, key, new Date(payload.endedAt)) !== undefined;
  // A sandbox token's own key is trusted only through a reviewed allowed_signers line.
  if (!listed && payload.attester.tokenKind === "sandbox") return invalid(`signature: the key is not in ${ALLOWED_SIGNERS_FILE} at HEAD^1 for ${principal}`);

  const github = new GitHub(env);
  const user = await github.get(`/user/${payload.attester.account}`);
  if (user.kind === "failed") return user.problem;
  if (user.kind === "not_found") return invalid(`signature: GitHub account ${payload.attester.account} no longer exists`);
  const login = (user.body as { login?: unknown }).login;
  if (typeof login !== "string") return { reason: "github_unavailable", detail: `GET /user/${payload.attester.account} answered without a login` };

  const repository = env.GITHUB_REPOSITORY ?? "";
  const [keys, permission] = await Promise.all([
    listed ? undefined : github.get(`/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`),
    github.get(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`),
  ]);
  if (keys?.kind === "failed") return keys.problem;
  if (permission.kind === "failed") return permission.problem;
  if (keys) {
    const list = keys.kind === "ok" && Array.isArray(keys.body) ? (keys.body as { key?: unknown }[]) : [];
    const onGitHub = list.some((entry) => {
      const listedKey = typeof entry.key === "string" ? parsePublicKey(entry.key) : undefined;
      return listedKey !== undefined && sameKey(listedKey, key);
    });
    if (!onGitHub) return invalid(`signature: the key is neither among @${login}'s GitHub signing keys nor in ${ALLOWED_SIGNERS_FILE} at HEAD^1`);
  }
  const role = permission.kind === "ok" ? (permission.body as { permission?: unknown }).permission : "none";
  if (role !== "admin" && role !== "write") return invalid(`permission: @${login} has ${typeof role === "string" ? role : "none"}, not admin or write`);
  return undefined;
}

type GitHubAnswer = { kind: "ok"; body: unknown } | { kind: "not_found" } | { kind: "failed"; problem: Problem };

/** GitHub's REST API with the job's `GITHUB_TOKEN`: no HTTP cache, no conditional requests, no retry. */
class GitHub {
  private readonly api: string;
  private readonly token: string;
  constructor(env: RunnerEnv) {
    this.api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
    this.token = input(env, "github-token");
  }

  async get(path: string): Promise<GitHubAnswer> {
    const what = `GET ${path.replace(/\?.*$/, "")}`;
    const unavailable = (detail: string): GitHubAnswer => ({ kind: "failed", problem: { reason: "github_unavailable", detail } });
    if (!this.token) return unavailable("the github-token input is empty");
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "testnotary-action",
          "cache-control": "no-cache",
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      return unavailable(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) return { kind: "not_found" };
    if (!response.ok) {
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      return unavailable(`${what} ${limited ? "was rate-limited" : `answered ${response.status}`}`);
    }
    try {
      return { kind: "ok", body: (await response.json()) as unknown };
    } catch {
      return unavailable(`${what} answered without JSON`);
    }
  }
}

/** Git's trimmed stdout in the checkout, or undefined when it fails. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    );
  });
}
