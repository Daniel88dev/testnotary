import { setTimeout as pause } from "node:timers/promises";
import { API_V1, OIDC_AUDIENCE, resolveServiceUrl } from "./shared.ts";
import type { RunnerEnv } from "./runner.ts";

// Calls to the service from the runner. Each call has a 10 s budget, the token fetch included. A
// connection error, a 5xx or a 429 gets one retry after 1 s, within what is left of the budget;
// anything else is the answer at once. The service spends every token's `jti` it accepts, so a
// token goes out again only when no answer came back (a connection error), and then only with
// 60 s or more left; otherwise the retry fetches a fresh one.

/** Every service call's budget, token fetch and retry included. */
export const BUDGET_MS = 10_000;
/** The pause before the one retry. */
export const RETRY_AFTER_MS = 1_000;
/** A token with less than this left is fetched anew before it goes out again. */
const REFRESH_BELOW_MS = 60_000;

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
  /** No token: the job has none (`message` undefined), or the runner's token request failed. */
  | { kind: "no_token"; message?: string }
  | { kind: "unreachable"; message: string }
  | { kind: "timeout" }
  | { kind: "not_json"; status: number };

/** A token the step holds, and when it runs out by the runner's clock. */
interface HeldToken {
  value: string;
  expiresAt: number;
}

/** One `API_V1` call with the job's token, within the budget, retried once when it may help. Never throws. */
export async function callService(env: RunnerEnv, method: "GET" | "POST", path: string, body?: unknown): Promise<ServiceAnswer> {
  const budget = AbortSignal.timeout(BUDGET_MS);
  let token: HeldToken | undefined;
  for (let attempt = 1; ; attempt++) {
    if (!token || token.expiresAt - Date.now() < REFRESH_BELOW_MS) {
      const fetched = await fetchToken(env, budget);
      if ("kind" in fetched) return fetched;
      token = fetched;
    }
    const answer = await send(env, method, path, body, token.value, budget);
    if (attempt > 1 || !worthRetrying(answer)) return answer;
    // Whatever answered may have been the service, which spent the token's `jti` on accepting it.
    if (answer.kind !== "unreachable") token = undefined;
    try {
      await pause(RETRY_AFTER_MS, undefined, { signal: budget });
    } catch {
      // The budget ends before the retry could start: the first answer stands.
      return answer;
    }
  }
}

/** A connection error, a 5xx or a 429: something a second try a moment later may not meet. */
function worthRetrying(answer: ServiceAnswer): boolean {
  if (answer.kind === "unreachable") return true;
  if (answer.kind !== "answer" && answer.kind !== "not_json") return false;
  return answer.status === 429 || answer.status >= 500;
}

async function fetchToken(env: RunnerEnv, signal: AbortSignal): Promise<HeldToken | ServiceAnswer> {
  const fetchedAt = Date.now();
  let value: string | undefined;
  try {
    value = await idToken(env, signal);
  } catch (error) {
    return isTimeout(error) ? { kind: "timeout" } : { kind: "no_token", message: error instanceof Error ? error.message : String(error) };
  }
  if (!value) return { kind: "no_token" };
  return { value, expiresAt: fetchedAt + lifetimeMs(value) };
}

/**
 * How long a token lives (`exp - iat`), counted from when the step asked for it, so a runner clock
 * that is off doesn't matter. 0 when the token doesn't say: it is then never sent twice.
 */
function lifetimeMs(jwt: string): number {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown; iat?: unknown };
    return typeof claims.exp === "number" && typeof claims.iat === "number" ? Math.max(0, (claims.exp - claims.iat) * 1000) : 0;
  } catch {
    return 0;
  }
}

async function send(env: RunnerEnv, method: string, path: string, body: unknown, token: string, signal: AbortSignal): Promise<ServiceAnswer> {
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
