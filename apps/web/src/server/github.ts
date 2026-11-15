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

/** A person's permission on a repo, folded as GitHub folds roles: maintain → write, triage → read. */
export type RepoPermission = "admin" | "write" | "read";

function foldPermissions(value: unknown): RepoPermission | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (p.admin === true) return "admin";
  if (p.maintain === true || p.push === true) return "write";
  if (p.triage === true || p.pull === true) return "read";
  return undefined;
}

function asUser(userToken: string): RequestInit {
  return { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${userToken}` } };
}

/**
 * The person's permission on a repo, asked as them: `undefined` when GitHub does not show them the
 * repo (404, or no permission). A user token of the App reaches only repos the App is installed on.
 */
export async function fetchRepoPermission(userToken: string, fullName: string): Promise<RepoPermission | undefined> {
  const path = fullName.split("/").map(encodeURIComponent).join("/");
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${path}`, asUser(userToken));
  if (response.status === 404 || response.status === 403 || response.status === 401) return undefined;
  const body = await jsonBody(response);
  if (!response.ok) throw new GitHubUnavailable(`GET /repos/${fullName} answered ${response.status}`);
  return foldPermissions(body.permissions);
}

export interface AccessibleRepo {
  id: number;
  fullName: string;
  permission: RepoPermission;
  /** The installation it came through, and the GitHub account that installation is on. */
  installationId: number;
  installationAccountId: number;
}

const PER_PAGE = 100;
/** A person in more installations or repos than this is shown the first ones only. */
const MAX_PAGES = 10;

/**
 * Every repo the person can access through an installation of the App (GitHub lists the repos they
 * have explicit read, write or admin access to): `GET /user/installations`, then each one's
 * `repositories`.
 */
export async function fetchAccessibleRepos(userToken: string): Promise<AccessibleRepo[]> {
  const api = serviceConfig().githubApiUrl;
  const installations: { id: number; accountId: number }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await call(`${api}/user/installations?per_page=${PER_PAGE}&page=${page}`, asUser(userToken));
    if (response.status === 401 || response.status === 403) return [];
    const body = await jsonBody(response);
    if (!response.ok) throw new GitHubUnavailable(`GET /user/installations answered ${response.status}`);
    const listed = Array.isArray(body.installations) ? (body.installations as Record<string, unknown>[]) : [];
    for (const item of listed) {
      const account = item.account as Record<string, unknown> | undefined;
      if (typeof item.id === "number" && typeof account?.id === "number") installations.push({ id: item.id, accountId: account.id });
    }
    if (listed.length < PER_PAGE) break;
  }
  const repos: AccessibleRepo[] = [];
  for (const installation of installations) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${api}/user/installations/${installation.id}/repositories?per_page=${PER_PAGE}&page=${page}`;
      const response = await call(url, asUser(userToken));
      if (response.status === 404 || response.status === 403) break;
      const body = await jsonBody(response);
      if (!response.ok) throw new GitHubUnavailable(`GET /user/installations/${installation.id}/repositories answered ${response.status}`);
      const listed = Array.isArray(body.repositories) ? (body.repositories as Record<string, unknown>[]) : [];
      for (const item of listed) {
        const permission = foldPermissions(item.permissions);
        if (typeof item.id !== "number" || typeof item.full_name !== "string" || !permission) continue;
        repos.push({ id: item.id, fullName: item.full_name, permission, installationId: installation.id, installationAccountId: installation.accountId });
      }
      if (listed.length < PER_PAGE) break;
    }
  }
  return repos;
}

/** A GitHub avatar, fetched by the service so browsers never contact GitHub. `undefined` if GitHub has none. */
export async function fetchAvatar(accountId: number): Promise<{ body: ArrayBuffer; contentType: string } | undefined> {
  let response: Response;
  try {
    response = await fetch(`${serviceConfig().githubAvatarsUrl}/u/${accountId}?s=80&v=4`, {
      headers: { "user-agent": "testnotary-service" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(contentType)) return undefined;
  return { body: await response.arrayBuffer(), contentType };
}
