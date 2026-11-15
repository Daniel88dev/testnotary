import { API_V1, OIDC_AUDIENCE, resolveServiceUrl } from "./shared.ts";
import type { RunnerEnv } from "./runner.ts";

// Calls to the service from the runner. Each call carries a fresh Actions OIDC token: the service
// spends every token's `jti`, so none is reused across calls.

/** Every service call's budget, token fetch included. */
export const BUDGET_MS = 10_000;

/** Asks the runner for an OIDC token with Testnotary's audience, or undefined when the job has none. */
export async function idToken(env: RunnerEnv, signal: AbortSignal): Promise<string | undefined> {
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

/** How one call went: the service's answer, or why there was none. */
export type ServiceAnswer =
  | { kind: "answer"; status: number; body: unknown }
  | { kind: "no_token" }
  | { kind: "unreachable"; message: string }
  | { kind: "timeout" }
  | { kind: "not_json"; status: number };

/** One `API_V1` call with a fresh job token, within the budget. Never throws. */
export async function callService(env: RunnerEnv, method: "GET" | "POST", path: string, body?: unknown): Promise<ServiceAnswer> {
  const signal = AbortSignal.timeout(BUDGET_MS);
  let token: string | undefined;
  try {
    token = await idToken(env, signal);
  } catch (error) {
    return isTimeout(error) ? { kind: "timeout" } : { kind: "no_token" };
  }
  if (!token) return { kind: "no_token" };
  let response: Response;
  try {
    response = await fetch(`${resolveServiceUrl(env)}${API_V1}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return isTimeout(error) ? { kind: "timeout" } : { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { kind: "answer", status: response.status, body: await response.json() };
  } catch (error) {
    return isTimeout(error) ? { kind: "timeout" } : { kind: "not_json", status: response.status };
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}
