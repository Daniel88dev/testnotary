import { readFileSync } from "node:fs";
import {
  FALLBACK_REASONS,
  IP_ALLOW_LIST_DETAIL,
  namesIpAllowList,
  verifyResponse,
  type CiEnvironment,
  type FallbackReason,
  type Verification,
  type VerificationResult,
} from "./shared.ts";

/** Whether the code is one this action knows the words for. */
export function isFallbackReason(code: string): code is FallbackReason {
  return (FALLBACK_REASONS as readonly string[]).includes(code);
}
import { command, type RunnerEnv } from "./runner.ts";
import { callService, type ServiceAnswer } from "./service.ts";

// Verification from the runner: fetch the job's OIDC token, ask the service, and turn its answer
// into a verdict. The request carries the token, the suite and the runner's environment only;
// never a SHA, a tree or paths, which the service takes from the token and from GitHub.

/** What the job decided about its tests, before running or skipping them. */
export interface Verdict {
  result: VerificationResult;
  /**
   * The fallback reason; null for a skip or *would skip*. A code from the service this action
   * doesn't know (a newer one) stays as the service sent it, and is always a fallback.
   */
  reason: string | null;
  /**
   * What the reason's line names besides the code, e.g. the guarded file for
   * `guarded_file_changed` or the failed condition of a signature check. Null when nothing.
   */
  detail: string | null;
  /**
   * GitHub's own words, for `github_denied` caused by an IP allow list only: the service passes
   * GitHub's message on, and the job summary quotes it.
   */
  githubMessage?: string;
  /** The verification as the service recorded it; null when there is none (a fallback before or around the service). */
  record: Verification | null;
}

/** A fallback the action decides itself, with no recorded verification. */
export const fallback = (reason: FallbackReason, detail: string | null = null): Verdict => ({ result: "fallback", reason, detail, record: null });

/** The runner's environment as the service records it (never used to decide). */
export function ciEnvironment(env: RunnerEnv): CiEnvironment {
  return {
    os: env.RUNNER_OS || "unknown",
    arch: env.RUNNER_ARCH || "unknown",
    image: env.ImageOS || null,
    imageVersion: env.ImageVersion || null,
    node: process.version,
  };
}

/** The only GitHub host v1 serves. */
const GITHUB_COM = "https://github.com";

/**
 * The fallbacks the action decides before it fetches a token or calls the service, in the spec's
 * order: the kill switch (`TESTNOTARY_DISABLED`, a repository variable), then the host. Undefined
 * when neither applies and the job goes on to verify.
 */
export function beforeTheService(env: RunnerEnv): Verdict | undefined {
  if ((env.TESTNOTARY_DISABLED ?? "").trim().toLowerCase() === "true") return fallback("disabled");
  const server = (env.GITHUB_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  if (server !== GITHUB_COM) {
    command("notice", `Testnotary: v1 serves github.com only, not ${server || "a runner without GITHUB_SERVER_URL"}, so the tests run (host_not_supported).`);
    return fallback("host_not_supported");
  }
  return undefined;
}

/**
 * Verifies the job for `suite` (null: the config's only suite). Every way this can fail is a
 * fallback, never a skip.
 */
export async function verifyJob(env: RunnerEnv, suite: string | null): Promise<Verdict> {
  const answer = await callService(env, "POST", "/verifications", { suite, environment: ciEnvironment(env) });
  if (answer.kind === "no_token") noTokenNotice(env, answer.message);
  return verdictFrom(answer);
}

/**
 * Why the job has no OIDC token, said once: a fork's pull request never gets one (a plain notice:
 * nothing to fix), a same-repo job lacks `permissions: id-token: write` (a warning to add it), or
 * the runner's token request failed.
 */
function noTokenNotice(env: RunnerEnv, failure: string | undefined): void {
  if (failure) command("warning", `Testnotary: the runner's OIDC token request failed (${failure}), so the tests run (no_oidc_token).`);
  else if (fromFork(env)) command("notice", "Testnotary: a pull request from a fork gets no OIDC token, so the tests run (no_oidc_token).");
  else command("warning", "Testnotary: the job has no OIDC token, so the tests run (no_oidc_token). Add `permissions: id-token: write` to the job to let Testnotary verify it.");
}

/** Whether the event is a pull request whose head lives in another repository than this run's. */
function fromFork(env: RunnerEnv): boolean {
  if (!env.GITHUB_EVENT_PATH) return false;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { head?: { repo?: { full_name?: unknown } | null } } };
    const head = event.pull_request?.head;
    if (!head) return false;
    // A deleted fork's head has `repo: null`.
    return head.repo?.full_name !== env.GITHUB_REPOSITORY;
  } catch {
    return false;
  }
}

/**
 * Reads back a gate job's verification by id, for the test step. Undefined when it can't be read,
 * or is not of the commit this job builds: the step then verifies on its own.
 */
export async function readVerification(env: RunnerEnv, id: string): Promise<Verdict | undefined> {
  const answer = await callService(env, "GET", `/verifications/${encodeURIComponent(id)}`);
  if (answer.kind !== "answer" || answer.status !== 200) return undefined;
  const verdict = verdictFrom(answer);
  if (!verdict.record || (env.GITHUB_SHA && verdict.record.commit !== env.GITHUB_SHA)) return undefined;
  return verdict;
}

function verdictFrom(answer: ServiceAnswer): Verdict {
  if (answer.kind === "no_token") return fallback("no_oidc_token");
  if (answer.kind === "timeout") return fallback("timeout");
  if (answer.kind === "unreachable") return fallback("service_unreachable");
  if (answer.kind === "not_json") return fallback("service_error");
  if (answer.status === 200) {
    const parsed = verifyResponse.safeParse(answer.body);
    if (!parsed.success) return fallback("service_error");
    const { verification, message } = parsed.data;
    const { reason } = verification;
    // Adding a reason code is a minor version: a code this action doesn't know is a fallback,
    // whatever result came with it, so the tests run.
    if (reason !== null && !isFallbackReason(reason)) {
      const shadow = verification.result === "would_skip" || verification.result === "would_fall_back";
      return { result: shadow ? "would_fall_back" : "fallback", reason, detail: verification.detail, record: verification };
    }
    const verdict: Verdict = { result: verification.result, reason, detail: verification.detail, record: verification };
    // GitHub refused the service, and the service recorded it: the summary quotes an IP allow list.
    return reason === "github_denied" && message && namesIpAllowList(message) ? { ...verdict, githubMessage: message } : verdict;
  }
  const { error, message } = (answer.body ?? {}) as { error?: unknown; message?: unknown };
  if (error === "github_denied") return githubDenied(typeof message === "string" ? message : "");
  if (error === "token_rejected" || error === "repo_not_installed") return fallback(error);
  return fallback("service_error");
}

/**
 * GitHub refused the service (a 403 from an older service, which did not record it). When GitHub's
 * message names an IP allow list, the line says so and the summary quotes the message: v1 has no
 * fixed IP addresses. Any other message stays out of the PR.
 */
function githubDenied(message: string): Verdict {
  if (!namesIpAllowList(message)) return fallback("github_denied");
  return { ...fallback("github_denied", IP_ALLOW_LIST_DETAIL), githubMessage: message };
}
