import { randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
import type { FakeInstallation } from "../app.ts";
import { githubError, json, notFound, route, type RouteContext } from "../router.ts";

// What the service does with the App's own credentials (NOTES/github-behaviours.md §0, §7, §10):
// buy an installation token with an App JWT, then read with it. Tokens carry only
// `contents: read` and `metadata: read`, and reach only the installation's repos. The action's
// signature check reads users and permissions with the job's `GITHUB_TOKEN` (§8), which reaches
// only the workflow's own repo.

const TOKEN_LIFETIME_MS = 3_600_000;

function bearer(request: Request): string | undefined {
  return /^(?:Bearer|token) (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

/**
 * The installation behind the request's `ghs_` token, or the 401 GitHub answers for a missing,
 * unknown or expired one. Use in every endpoint the service calls with an installation token.
 */
export function installationFor(context: RouteContext): FakeInstallation | Response {
  const value = bearer(context.request);
  const token = value ? context.github.state.installationTokens.get(value) : undefined;
  const installation = token && token.expiresAt > Date.now() ? context.github.state.installations.get(token.installationId) : undefined;
  if (!installation || installation.suspended) return githubError(401, "Bad credentials");
  return installation;
}

/**
 * Which repos the request's token reaches: an installation token its installation's repos, a job's
 * `GITHUB_TOKEN` its own repo (every `GITHUB_TOKEN` has metadata read, §7), or the 401 GitHub
 * answers. For the endpoints both the service and the action's signature check call (§7, §8).
 */
function readerFor(context: RouteContext): { reaches(repoId: number): boolean } | Response {
  const value = bearer(context.request);
  const job = value ? context.github.state.jobTokens.get(value) : undefined;
  if (job) return { reaches: (repoId) => repoId === job.repoId };
  const installation = installationFor(context);
  if (installation instanceof Response) return installation;
  return { reaches: (repoId) => installation.repoIds.has(repoId) };
}

export const installationRoutes = [
  // §10: POST /app/installations/{id}/access_tokens with the App JWT (RS256, iss = App id, ≤ 10 min).
  route("POST", "/app/installations/:id/access_tokens", async ({ request, params, github }) => {
    const jwt = bearer(request);
    if (!jwt) return githubError(401, "A JSON web token could not be decoded");
    try {
      const { payload } = await jwtVerify(jwt, github.app.publicKey, { algorithms: ["RS256"], issuer: String(github.app.id), clockTolerance: 60 });
      if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp - payload.iat > 600) {
        return githubError(401, "'Expiration time' claim ('exp') is too far in the future");
      }
    } catch {
      return githubError(401, "A JSON web token could not be decoded");
    }
    const installation = github.state.installations.get(Number(params.id));
    if (!installation) return notFound();
    if (installation.suspended) return githubError(403, "This installation has been suspended");
    const token = `ghs_${randomBytes(27).toString("base64url")}`;
    const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    github.state.installationTokens.set(token, { installationId: installation.id, expiresAt });
    return json(201, {
      token,
      expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
      permissions: { contents: "read", metadata: "read" },
      repository_selection: "selected",
    });
  }),

  // §8: GET /user/{account_id}. 404 for an id GitHub doesn't know.
  route("GET", "/user/:id", (context) => {
    const reader = readerFor(context);
    if (reader instanceof Response) return reader;
    const account = /^\d+$/.test(context.params.id!) ? context.github.state.accountById(Number(context.params.id)) : undefined;
    if (!account) return notFound();
    return json(200, { login: account.login, id: account.id, node_id: `U_${account.id}`, type: account.type, site_admin: false });
  }),

  // §7: GET /repos/{owner}/{repo}/collaborators/{username}/permission. `read` for a user with no
  // access on a public repo, `none` on a private one, 404 "… is not a user" for an unknown login.
  // A repo outside the installation is a 404, as GitHub hides what a token can't reach.
  route("GET", "/repos/:owner/:repo/collaborators/:username/permission", (context) => {
    const reader = readerFor(context);
    if (reader instanceof Response) return reader;
    const { github, params } = context;
    const repo = github.state.repo(params.owner!, params.repo!);
    if (!repo || !reader.reaches(repo.id)) return notFound();
    const account = github.state.accounts.get(params.username!.toLowerCase());
    if (!account || account.type !== "User") return githubError(404, `${params.username} is not a user`);
    const permission = github.state.permission(repo, account);
    const roles = { admin: "admin", write: "write", read: "read", none: "none" } as const;
    return json(200, {
      permission,
      role_name: github.state.permissions.get(repo.id)?.get(account.id) ?? roles[permission],
      user: { login: account.login, id: account.id, type: "User" },
    });
  }),
];
