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
import { git } from "./git.ts";
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
import type { JobAnswer } from "./verify.ts";

/** How old a signature may be, counted from its signing time (the run's end). */
export const SIGNATURE_MAX_AGE_MS = 24 * 3_600_000;
/** How far the signing time may lie ahead of the runner's clock. */
export const SIGNATURE_CLOCK_SKEW_MS = 5 * 60_000;
/** Each GitHub call's budget. Nothing is retried or cached. */
const GITHUB_TIMEOUT_MS = 10_000;

/**
 * The answer the job acts on: a `skip` in a repo whose base config requires signatures stands
 * only when the attestation's signature passes the check; otherwise the job falls back (keeping
 * the service's record, so the tests still report against it). Shadow mode previews the same
 * check: a *would skip* whose signature would fail reads *would have fallen back* with the
 * signature's reason, so it never counts as evidence for enforce. Any other answer is returned as
 * it is: only a skip is ever trusted.
 */
export async function checkSkip(env: RunnerEnv, jobAnswer: JobAnswer, suiteInput: string | null): Promise<JobAnswer> {
  if (jobAnswer.result !== "skip" && jobAnswer.result !== "would_skip") return jobAnswer;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const mode = await signatureRequirement(env, workspace);
  if (mode.kind === "off") return jobAnswer;
  const result = jobAnswer.result === "skip" ? "fallback" : "would_fall_back";
  const fallBack = (reason: FallbackReason, detail: string | null = null): JobAnswer => ({ result, reason, detail, record: jobAnswer.record });
  if (mode.kind === "unchecked") return fallBack(mode.problem.reason, mode.problem.detail);
  const attestation = jobAnswer.record?.attestation;
  if (!attestation?.signature || attestation.payload === null) return fallBack("signature_missing");
  const failed = await signatureProblem(env, workspace, mode.config, suiteInput, attestation.payload, attestation.signature.sshsig);
  return failed ? fallBack(failed.reason, failed.detail) : jobAnswer;
}

/**
 * Whether a skip needs the signature check: `off` when the base config doesn't require signatures,
 * `required` with the base config to check against, or `unchecked` when it requires them (or can't
 * be told) but can't be checked here. A skip that is `unchecked` falls back with the problem.
 */
type SignatureRequirement = { kind: "off" } | { kind: "required"; config: TestnotaryConfig } | { kind: "unchecked"; problem: Problem };

/**
 * Whether the repo requires signatures, from `testnotary.json` at the built commit's first parent,
 * decided apart from the checkout and from what this action's parser accepts, so that neither can
 * turn the check off:
 *
 * - with `HEAD^1` in the checkout, the config is read there; without it (`fetch-depth: 1`, or a
 *   gate job with no checkout at all) through GitHub's API with the step's `github-token`: the
 *   commit's first parent, then the file at it. Only a skip pays for these two calls;
 * - the raw JSON's `signatures` field decides, even when the strict schema rejects the file (a key
 *   from a later release, say); a file that exists but isn't JSON can't say, and falls back;
 * - a repo that requires signatures needs the checkout's `HEAD^1` for the tree, command and diff
 *   conditions: without it the skip falls back, saying to check out with `fetch-depth: 2`.
 */
async function signatureRequirement(env: RunnerEnv, workspace: string): Promise<SignatureRequirement> {
  const head = await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const parent = head === undefined ? undefined : await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD^1^{commit}"]);
  let text: string | undefined;
  if (parent !== undefined) text = await git(workspace, ["show", `HEAD^1:${CONFIG_FILE}`]);
  else {
    const read = await baseConfigFromGitHub(env);
    if (read.kind === "failed") return { kind: "unchecked", problem: read.problem };
    text = read.text;
  }
  if (text === undefined) return { kind: "off" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { kind: "unchecked", problem: invalid(`config: ${CONFIG_FILE} at HEAD^1 is unreadable`) };
  }
  if (!raw || typeof raw !== "object" || (raw as { signatures?: unknown }).signatures !== "required") return { kind: "off" };
  const parsed = parseConfig(text);
  if (!parsed.ok) return { kind: "unchecked", problem: invalid(`config: ${CONFIG_FILE} at HEAD^1 requires signatures, but this action can't read it: ${parsed.problems[0] ?? "invalid"}`) };
  if (head === undefined) return { kind: "unchecked", problem: invalid("checkout: the repo requires signatures and the job has no checkout; check out with fetch-depth: 2") };
  if (parent === undefined) return { kind: "unchecked", problem: invalid("checkout: the repo requires signatures and HEAD^1 is missing; check out with fetch-depth: 2") };
  return { kind: "required", config: parsed.config };
}

/**
 * `testnotary.json` at `GITHUB_SHA`'s first parent through GitHub's API, for a job whose checkout
 * can't show it: the text, undefined when the parent has no such file (or the commit no parent).
 * A failed call, or a commit GitHub doesn't show the token, can't be told from a repo without
 * signatures, so it fails.
 */
async function baseConfigFromGitHub(env: RunnerEnv): Promise<{ kind: "read"; text: string | undefined } | { kind: "failed"; problem: Problem }> {
  const github = new GitHub(env);
  const repository = env.GITHUB_REPOSITORY ?? "";
  const sha = env.GITHUB_SHA ?? "";
  const commit = await github.get(`/repos/${repository}/commits/${encodeURIComponent(sha)}`);
  if (commit.kind === "failed") return commit;
  if (commit.kind === "not_found") return { kind: "failed", problem: { reason: "github_unavailable", detail: `GET /repos/${repository}/commits/${sha.slice(0, 12)} found no such commit` } };
  const parents = (commit.body as { parents?: { sha?: unknown }[] }).parents;
  const first = Array.isArray(parents) ? parents[0]?.sha : undefined;
  if (first === undefined) return { kind: "read", text: undefined };
  if (typeof first !== "string") return { kind: "failed", problem: { reason: "github_unavailable", detail: `GET /repos/${repository}/commits answered without its parents` } };
  const file = await github.get(`/repos/${repository}/contents/${CONFIG_FILE}?ref=${encodeURIComponent(first)}`);
  if (file.kind === "failed") return file;
  if (file.kind === "not_found") return { kind: "read", text: undefined };
  const { type, encoding, content } = file.body as { type?: unknown; encoding?: unknown; content?: unknown };
  if (type !== "file" || encoding !== "base64" || typeof content !== "string") {
    return { kind: "failed", problem: { reason: "github_unavailable", detail: `GET /repos/${repository}/contents/${CONFIG_FILE} answered without the file's content` } };
  }
  return { kind: "read", text: Buffer.from(content, "base64").toString("utf8") };
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
