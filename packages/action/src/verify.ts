import { verifyResponse, type CiEnvironment, type FallbackReason, type Verification, type VerificationResult } from "./shared.ts";
import type { RunnerEnv } from "./runner.ts";
import { callService, type ServiceAnswer } from "./service.ts";

// Verification from the runner: fetch the job's OIDC token, ask the service, and turn its answer
// into a verdict. The request carries the token, the suite and the runner's environment only;
// never a SHA, a tree or paths, which the service takes from the token and from GitHub.

/** What the job decided about its tests, before running or skipping them. */
export interface Verdict {
  result: VerificationResult;
  /** The fallback reason; null for a skip or *would skip*. */
  reason: FallbackReason | null;
  /**
   * What the reason's line names besides the code, e.g. the guarded file for
   * `guarded_file_changed` or the failed condition of a signature check. Null when nothing.
   */
  detail: string | null;
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

/**
 * Verifies the job for `suite` (null: the config's only suite). Every way this can fail is a
 * fallback, never a skip.
 */
export async function verifyJob(env: RunnerEnv, suite: string | null): Promise<Verdict> {
  const answer = await callService(env, "POST", "/verifications", { suite, environment: ciEnvironment(env) });
  return verdictFrom(answer);
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
    const { verification } = parsed.data;
    return { result: verification.result, reason: (verification.reason as FallbackReason | null) ?? null, detail: verification.detail, record: verification };
  }
  const error = (answer.body as { error?: unknown } | null)?.error;
  if (error === "token_rejected" || error === "repo_not_installed" || error === "github_denied") return fallback(error);
  return fallback("service_error");
}
