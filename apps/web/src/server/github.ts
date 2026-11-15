import { createPrivateKey, createSign } from "node:crypto";
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

/** GitHub refused an installation-token call with 403 (an IP allow list, for one). Its message is kept. */
export class GitHubDenied extends Error {}

/**
 * The App JWT (§10): RS256 over `{iat, exp, iss: <App id>}`, back-dated 60 s for clock drift and
 * valid for 9 minutes. Its times are GitHub's real time, not the service clock: GitHub checks them.
 */
function appJwt(): string {
  const { githubAppId, githubAppPrivateKey } = serviceConfig();
  if (!githubAppId || !githubAppPrivateKey) throw new GitHubNotConfigured("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set");
  const seconds = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: githubAppId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(githubAppPrivateKey)).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function failure(response: Response, what: string): Promise<never> {
  let message = `${what} answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") message = body.message;
  } catch {
    // Keep the status line.
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0") throw new GitHubDenied(message);
  throw new GitHubUnavailable(message);
}

/**
 * A fresh installation token (`contents: read`, `metadata: read`) for one installation. Bought for
 * each request that needs one; nothing caches it yet.
 */
export async function installationToken(installationId: number): Promise<string> {
  const response = await call(`${serviceConfig().githubApiUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt()}` },
  });
  if (response.status !== 201) return failure(response, "the installation token request");
  const body = await jsonBody(response);
  if (typeof body.token !== "string") throw new GitHubUnavailable("the installation token answer has no token");
  return body.token;
}

function withToken(token: string): RequestInit {
  return { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } };
}

/** `GET /user/{id}` (§8): the account's login now, or undefined when GitHub knows no such id. */
export async function userById(token: string, accountId: number): Promise<{ id: number; login: string } | undefined> {
  const response = await call(`${serviceConfig().githubApiUrl}/user/${accountId}`, withToken(token));
  if (response.status === 404) return undefined;
  if (!response.ok) return failure(response, `GET /user/${accountId}`);
  const body = await jsonBody(response);
  if (typeof body.id !== "number" || typeof body.login !== "string") throw new GitHubUnavailable(`GET /user/${accountId} answered without a login`);
  return { id: body.id, login: body.login };
}

/**
 * `GET /users/{login}/ssh_signing_keys` (§8): the account's SSH signing keys as `type base64`, or
 * undefined when GitHub knows no such login. Up to 100, the most a page holds.
 */
export async function sshSigningKeys(token: string, login: string): Promise<string[] | undefined> {
  const response = await call(`${serviceConfig().githubApiUrl}/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, withToken(token));
  if (response.status === 404) return undefined;
  if (!response.ok) return failure(response, "the ssh_signing_keys call");
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!Array.isArray(body)) throw new GitHubUnavailable("the ssh_signing_keys call answered without a list");
  return body.map((entry: { key?: unknown }) => (typeof entry.key === "string" ? entry.key : "")).filter(Boolean);
}

export type CollaboratorPermission = "admin" | "write" | "read" | "none";

/**
 * `GET /repos/{owner}/{repo}/collaborators/{login}/permission` (§7). A login GitHub calls "not a
 * user" reads `none`. Note `read` is what anyone gets on a public repo.
 */
export async function collaboratorPermission(token: string, fullName: string, login: string): Promise<CollaboratorPermission> {
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`, withToken(token));
  if (response.status === 404) return "none";
  if (!response.ok) return failure(response, "the collaborator permission call");
  const body = await jsonBody(response);
  const permission = body.permission;
  return permission === "admin" || permission === "write" || permission === "read" ? permission : "none";
}

/**
 * `GET /repos/{owner}/{repo}/git/commits/{sha}` (§4): the commit's tree and parents, or undefined
 * when GitHub has no such commit. A commit object never changes, so this answer can't go stale.
 */
export async function gitCommit(token: string, fullName: string, sha: string): Promise<{ tree: string; parents: string[] } | undefined> {
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/git/commits/${encodeURIComponent(sha)}`, withToken(token));
  if (response.status === 404 || response.status === 422) return undefined;
  if (!response.ok) return failure(response, "the git commits call");
  const body = await jsonBody(response);
  const tree = (body.tree as { sha?: unknown } | undefined)?.sha;
  const parents: unknown[] | undefined = Array.isArray(body.parents) ? body.parents.map((parent: { sha?: unknown }) => parent.sha) : undefined;
  if (typeof tree !== "string" || !parents?.every((sha): sha is string => typeof sha === "string")) {
    throw new GitHubUnavailable("the git commits call answered without a tree or parents");
  }
  return { tree, parents };
}

/**
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` (§5), which needs only Contents read: every
 * path `head` changes against `base`, a renamed file's old path included. From a merge commit to
 * its first parent that is the pull request's files. GitHub lists 300 files at most for a whole
 * comparison, so `count` is how many it listed; a caller treats a full list as possibly cut short.
 */
export async function changedPaths(token: string, fullName: string, base: string, head: string): Promise<{ paths: string[]; count: number }> {
  const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/compare/${basehead}`, withToken(token));
  if (!response.ok) return failure(response, "the compare call");
  const body = await jsonBody(response);
  if (!Array.isArray(body.files)) throw new GitHubUnavailable("the compare call answered without files");
  const paths: string[] = [];
  for (const file of body.files as { filename?: unknown; previous_filename?: unknown }[]) {
    if (typeof file.filename !== "string") throw new GitHubUnavailable("the compare call answered a file without a filename");
    paths.push(file.filename);
    if (typeof file.previous_filename === "string") paths.push(file.previous_filename);
  }
  return { paths, count: body.files.length };
}

/** A commit's author as GitHub shows it: the GitHub account it linked the commit to, if any, and the git author's name. */
export interface CommitAuthor {
  /** The GitHub account, when GitHub matched the author's email to one. */
  account: { id: number; login: string } | null;
  /** The git author's name, as written in the commit. */
  name: string;
  /** The commit's parents, to find a pull request's head under GitHub's test merge commit. */
  parents: string[];
}

/**
 * `GET /repos/{owner}/{repo}/commits/{sha}` (Contents read): who wrote the commit. Undefined when
 * GitHub has no such commit. Shown on the commit page beside the attester; never used to decide.
 */
export async function commitAuthor(token: string, fullName: string, sha: string): Promise<CommitAuthor | undefined> {
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/commits/${encodeURIComponent(sha)}`, withToken(token));
  if (response.status === 404 || response.status === 422) return undefined;
  if (!response.ok) return failure(response, "the commits call");
  const body = await jsonBody(response);
  const author = body.author as { id?: unknown; login?: unknown } | null | undefined;
  const commit = body.commit as { author?: { name?: unknown } } | undefined;
  const parents = Array.isArray(body.parents) ? body.parents.map((parent: { sha?: unknown }) => parent.sha).filter((sha): sha is string => typeof sha === "string") : [];
  return {
    account: author && typeof author.id === "number" && typeof author.login === "string" ? { id: author.id, login: author.login } : null,
    name: typeof commit?.author?.name === "string" ? commit.author.name : "",
    parents,
  };
}

/**
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`: how many commits `base` has that `head`
 * lacks (`behind_by`). The commit page's *base moved* flag: CI's base had commits the attested
 * commit did not.
 */
export async function behindBy(token: string, fullName: string, base: string, head: string): Promise<number> {
  const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/compare/${basehead}`, withToken(token));
  if (!response.ok) return failure(response, "the compare call");
  const body = await jsonBody(response);
  if (typeof body.behind_by !== "number") throw new GitHubUnavailable("the compare call answered without behind_by");
  return body.behind_by;
}

/**
 * `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` (§6): one file's text at a commit (with no
 * `ref`, on the default branch), or undefined when the commit has no such file.
 */
export async function fileAt(token: string, fullName: string, path: string, ref?: string): Promise<string | undefined> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
  const response = await call(`${serviceConfig().githubApiUrl}/repos/${fullName}/contents/${encoded}${query}`, withToken(token));
  if (response.status === 404) return undefined;
  if (!response.ok) return failure(response, "the contents call");
  const body = await jsonBody(response);
  if (body.type !== "file" || typeof body.content !== "string") return undefined;
  if (body.encoding !== "base64") throw new GitHubUnavailable(`the contents call answered in ${String(body.encoding)} encoding`);
  return Buffer.from(body.content, "base64").toString("utf8");
}

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
