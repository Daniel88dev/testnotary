import { API_V1, OIDC_AUDIENCE, resolveServiceUrl, verifyResponse, type CiEnvironment, type FallbackReason, type VerificationResult } from "./shared.ts";
import type { RunnerEnv } from "./runner.ts";

// Verification from the runner: fetch the job's OIDC token, ask the service, and turn its answer
// into a result. The request carries the token, the suite and the runner's environment only; never
// a SHA, a tree or paths, which the service takes from the token and from GitHub.

/** The whole verification's budget, token fetch included. */
const BUDGET_MS = 10_000;

export interface VerifyOutcome {
  result: VerificationResult;
  /** The fallback reason; null for a skip or *would skip*. */
  reason: FallbackReason | null;
  /** The verification's id, when the service recorded one. */
  verification: string | null;
}

const fallback = (reason: FallbackReason): VerifyOutcome => ({ result: "fallback", reason, verification: null });

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

/** Asks the runner for an OIDC token with Testnotary's audience, or undefined when the job has none. */
async function idToken(env: RunnerEnv, signal: AbortSignal): Promise<string | undefined> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) return undefined;
  const response = await fetch(`${url}&audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`the runner's OIDC token request answered ${response.status}`);
  const body = (await response.json()) as { value?: unknown };
  if (typeof body.value !== "string") throw new Error("the runner's OIDC token request answered without a token");
  return body.value;
}

/**
 * Verifies the job for `suite` (null: the config's only suite). Every way this can fail is a
 * fallback, never a skip.
 */
export async function verifyJob(env: RunnerEnv, suite: string | null): Promise<VerifyOutcome> {
  const signal = AbortSignal.timeout(BUDGET_MS);
  let token: string | undefined;
  try {
    token = await idToken(env, signal);
  } catch (error) {
    return fallback(isTimeout(error) ? "timeout" : "no_oidc_token");
  }
  if (!token) return fallback("no_oidc_token");

  let response: Response;
  try {
    response = await fetch(`${resolveServiceUrl(env)}${API_V1}/verifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ suite, environment: ciEnvironment(env) }),
      signal,
    });
  } catch (error) {
    return fallback(isTimeout(error) ? "timeout" : "service_unreachable");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return fallback(isTimeout(error) ? "timeout" : "service_error");
  }
  if (response.ok) {
    const parsed = verifyResponse.safeParse(body);
    if (!parsed.success) return fallback("service_error");
    const { verification } = parsed.data;
    return { result: verification.result, reason: (verification.reason as FallbackReason | null) ?? null, verification: verification.id };
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (error === "token_rejected" || error === "repo_not_installed" || error === "github_denied") return fallback(error);
  return fallback("service_error");
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}
