import { serviceConfig } from "./config.ts";

// The service's calls to GitHub. Every call has a timeout; nothing here retries.

const TIMEOUT_MS = 10_000;

export class GitHubUnavailable extends Error {}

/** The service is missing a GitHub setting it needs for this call. */
export class GitHubNotConfigured extends Error {}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: { "user-agent": "testnotary-service", "x-github-api-version": "2022-11-28", ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubUnavailable(error instanceof Error ? error.message : String(error));
  }
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new GitHubUnavailable(`GitHub answered ${response.status} without JSON`);
  }
}

function clientId(): string {
  const id = serviceConfig().githubClientId;
  if (!id) throw new GitHubNotConfigured("GITHUB_CLIENT_ID is not set");
  return id;
}

/** `POST https://github.com/login/device/code` with the App's client id (§11). */
export async function requestDeviceCode(): Promise<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }> {
  const response = await call(`${serviceConfig().githubWebUrl}/login/device/code`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId() }).toString(),
  });
  const body = await jsonBody(response);
  if (!response.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new GitHubUnavailable(`device code request answered ${response.status}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device",
    interval: typeof body.interval === "number" ? body.interval : 5,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
  };
}

export type DevicePoll =
  | { kind: "token"; accessToken: string }
  | { kind: "pending"; slowDown: boolean; interval?: number }
  | { kind: "ended"; error: "expired_token" | "access_denied" }
  | { kind: "error"; message: string };

/** One poll of `POST https://github.com/login/oauth/access_token` for a device code (§11). */
export async function pollDeviceCode(deviceCode: string): Promise<DevicePoll> {
  const response = await call(`${serviceConfig().githubWebUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
  });
  const body = await jsonBody(response);
  if (typeof body.access_token === "string") return { kind: "token", accessToken: body.access_token };
  const error = typeof body.error === "string" ? body.error : `status ${response.status}`;
  if (error === "authorization_pending") return { kind: "pending", slowDown: false };
  if (error === "slow_down") return { kind: "pending", slowDown: true, ...(typeof body.interval === "number" ? { interval: body.interval } : {}) };
  if (error === "expired_token" || error === "access_denied") return { kind: "ended", error };
  const description = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
  return { kind: "error", message: `${error}${description}` };
}

export type GitHubUser =
  | { kind: "user"; id: number; login: string }
  | { kind: "denied"; status: number; message: string };

/** `GET /user` with the person's `ghu_` token, the one call the service ever makes with it. */
export async function fetchUser(userToken: string): Promise<GitHubUser> {
  const response = await call(`${serviceConfig().githubApiUrl}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${userToken}` },
  });
  if (response.status === 401 || response.status === 403) {
    let message = `GitHub answered ${response.status}`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      // Keep the status line.
    }
    return { kind: "denied", status: response.status, message };
  }
  const body = await jsonBody(response);
  if (!response.ok || typeof body.id !== "number" || typeof body.login !== "string") {
    throw new GitHubUnavailable(`GET /user answered ${response.status}`);
  }
  return { kind: "user", id: body.id, login: body.login };
}
